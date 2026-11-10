"""Shared source-chapter checks at translation and publication boundaries."""

from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import select, update

from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.books.source_identity import source_url_identity
from app.modules.reader.service import filter_readable_text_assets, get_asset_title
from app.modules.translations.models import WholeBookTranslationJobRecord as Job

ACTIVE = {"queued", "processing", "waiting_quota"}
OPEN = ACTIVE | {"paused", "review"}


def published_source_conflicts(session, record):
    if record.job_kind != "source_update" or not record.book_id:
        return []
    book = SqlAlchemyBookRepository(session).get_owned(record.user_id, record.book_id)
    if not book or source_url_identity(book.source_url) != source_url_identity(
        record.source_url
    ):
        raise HTTPException(
            409,
            {
                "error_code": "translation_target_changed",
                "message": "目标书籍或来源已变化，请核对原作链接后再处理任务",
            },
        )
    from app.modules.books.publication_check import PublicationChapter
    from app.modules.translations.external_completion import (
        publication_evidence,
        catalog,
    )

    assets = filter_readable_text_assets(
        SqlAlchemyBookAssetRepository(session).list_by_book(book.id, "text_chapter")
    )
    chapters = [
        PublicationChapter(
            index=i,
            title=get_asset_title(a, i),
            content_hash="",
            source_url=source_url_identity(a.metadata.get("source_episode_url")),
            source_index=a.metadata.get("source_catalog_index")
            if type(a.metadata.get("source_catalog_index")) is int
            else None,
        )
        for i, a in enumerate(assets, 1)
    ]
    normalized = SimpleNamespace(
        catalog_json=[
            {**e.model_dump(), "url": source_url_identity(e.url)}
            for e in catalog(record)
        ],
        metadata_json=record.metadata_json,
    )
    return publication_evidence(normalized, chapters, allow_partial=True)


def require_unpublished_job(session, record):
    conflicts = published_source_conflicts(session, record)
    if conflicts:
        raise HTTPException(
            409,
            {
                "error_code": "source_chapters_already_published",
                "book_id": record.book_id,
                "job_id": record.id,
                "source_indexes": [e.source_index for e in conflicts],
                "message": "这批来源章节已有内容入库，请先核验并对账；已有译稿和检查点已保留",
            },
        )


def require_worker_target(session, record):
    if record is None:
        raise HTTPException(404, "Translation task not found")
    require_unpublished_job(session, record)
    if record.job_kind == "whole_book":
        require_new_source_available(
            session, record.user_id, record.source_url, job_id=record.id
        )
    if not record.book_id:
        return
    require_file_available(session, record.book_id)


def require_file_available(session, book_id):
    from app.modules.uploads.models import UploadTaskRecord

    task = session.scalar(
        select(UploadTaskRecord).where(
            UploadTaskRecord.book_id == book_id,
            UploadTaskRecord.status.in_({"queued", "processing"}),
        )
    )
    if task:
        raise HTTPException(
            409,
            {
                "error_code": "book_processing",
                "task_id": task.id,
                "message": "这本书正在处理文件，请等待文件处理完成后再继续翻译",
            },
        )


def require_external_write_available(
    session, owner_id, book_id, chapters=None, *, allow_stopped_file_operation=False
):
    """A stopped review/paused job can be taken over; a live worker cannot."""
    require_file_available(session, book_id)
    jobs = session.scalars(
        select(Job).where(
            Job.user_id == owner_id,
            Job.book_id == book_id,
            Job.status.not_in({"ready", "completed", "rejected"}),
        )
    ).all()
    incoming = (
        None
        if chapters is None
        else {source_url_identity(c.source_url) for c in chapters}
    )
    for job in jobs:
        if job.status in ACTIVE or job.lease_owner or job.lease_expires_at:
            raise HTTPException(
                409,
                {
                    "error_code": "translation_in_progress",
                    "job_id": job.id,
                    "message": "这本书有后台翻译任务，请先暂停并等待任务停稳，再提交外部成果",
                },
            )
        if chapters is None and allow_stopped_file_operation:
            continue
        reserved = {
            source_url_identity(e.get("url"))
            for e in (job.catalog_json or [])
            if isinstance(e, dict)
        }
        if (
            incoming is None
            or None in incoming
            or not reserved
            or None in reserved
            or not incoming.intersection(reserved)
        ):
            raise HTTPException(
                409,
                {
                    "error_code": "translation_batch_pending",
                    "job_id": job.id,
                    "message": "这本书还有未完成的来源批次，请先接管或对账该批次，再追加后续章节；外部接管请提供来源链接",
                },
            )


def lock_source_owner(session, owner_id):
    # Native whole-book creation and external projects share this lock, including
    # their final publication commits. The network fetch happens before locking.
    from app.modules.users.models import UserRecord

    if (
        session.execute(
            update(UserRecord)
            .where(UserRecord.id == owner_id)
            .values(updated_at=UserRecord.updated_at)
        ).rowcount
        != 1
    ):
        raise HTTPException(404, "User not found")


def require_new_source_available(
    session, owner_id, source_url, *, job_id=None, project_id=None
):
    identity = source_url_identity(source_url)
    from app.modules.books.models import BookRecord
    from app.modules.agent.models import AgentProjectRecord

    for book in session.scalars(
        select(BookRecord).where(
            BookRecord.owner_id == owner_id,
            BookRecord.status != "deleted",
            BookRecord.source_url.is_not(None),
        )
    ):
        if (
            book.id != job_id
            and book.id != project_id
            and source_url_identity(book.source_url) == identity
        ):
            raise HTTPException(
                409,
                {
                    "error_code": "source_book_exists",
                    "book_id": book.id,
                    "message": "这部原作已在书库中，请使用续章或替换原书，避免重复全本翻译",
                },
            )
    for job in session.scalars(
        select(Job).where(Job.user_id == owner_id, Job.status.in_(OPEN))
    ):
        if job.id != job_id and source_url_identity(job.source_url) == identity:
            raise HTTPException(
                409,
                {
                    "error_code": "source_translation_exists",
                    "job_id": job.id,
                    "message": "这部原作已有未完成翻译，请继续现有任务",
                },
            )
    for project in session.scalars(
        select(AgentProjectRecord).where(
            AgentProjectRecord.owner_id == owner_id,
            AgentProjectRecord.status == "draft",
        )
    ):
        if (
            project.id != project_id
            and source_url_identity((project.metadata_json or {}).get("source_url"))
            == identity
        ):
            raise HTTPException(
                409,
                {
                    "error_code": "source_project_exists",
                    "project_id": project.id,
                    "message": "这部原作已有外部翻译项目，请继续现有项目",
                },
            )
