"""Owner review and transactional publication of source-update drafts."""
from __future__ import annotations

from contextlib import suppress
from datetime import datetime, timezone
import logging
from pathlib import Path
import shutil
from typing import Callable
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.database_revisions import datetime_revision_matches
from app.core.storage import get_storage_root, resolve_storage_path
from app.modules.book_assets.repository import SqlAlchemyBookAssetRepository
from app.modules.books.repository import SqlAlchemyBookRepository
from app.modules.books.source_updates import resolve_matching_source_update_episodes
from app.modules.processing.service import run_processor
from app.modules.processing.processors.txt_processor import decode_text
from app.modules.reader.service import split_paragraphs
from app.modules.translations.checkpoints import (
    _job_root_path, _read_json, _remove_translation_job_storage, _translation_project_path,
)
from app.modules.translations.epub import append_translation_epub
from app.modules.translations.models import WholeBookTranslationJobRecord
from app.modules.translations.schemas import SourceUpdateTranslationDraftReview, WholeBookTranslationJobPublic
from app.modules.translations.source_update_projects import (
    _manual_epub_sidecar_chapters, _mark_source_update_episodes_dismissed,
    _merge_source_update_project, _project_episode_index, _read_source_update_draft_chapters,
)
from app.modules.translations.text import build_translation_txt
from app.modules.uploads.replacement_publication import publish_staged_replacement
from app.modules.uploads.replacement_storage import upload_book_processing_lock

logger = logging.getLogger(__name__)
PublicView = Callable[[WholeBookTranslationJobRecord, Session], WholeBookTranslationJobPublic]


def get_source_update_translation_review(user_id: str, job_id: str, session: Session,
    settings: Settings,
) -> SourceUpdateTranslationDraftReview | None:
    record = session.get(WholeBookTranslationJobRecord, job_id)
    if not record or record.user_id != user_id or record.job_kind != 'source_update':
        return None
    chapters = (_validated_draft_chapters(record, settings) if record.status == 'review'
        else _read_source_update_draft_chapters(record, settings))
    return SourceUpdateTranslationDraftReview(book_id=record.book_id or '', chapters=chapters,
        job_id=record.id, status='ready' if record.status == 'completed' else record.status, title=record.title)


def _review_record(user_id: str, job_id: str, session: Session):
    record = session.get(WholeBookTranslationJobRecord, job_id, populate_existing=True)
    if not record or record.user_id != user_id or record.job_kind != 'source_update':
        return None
    if record.status != 'review' or not record.book_id:
        raise HTTPException(409, '这份更新译稿当前不能处理，请刷新任务状态')
    return record


def _claim_review(record: WholeBookTranslationJobRecord, session: Session) -> None:
    result = session.execute(update(WholeBookTranslationJobRecord).where(
        WholeBookTranslationJobRecord.id == record.id,
        WholeBookTranslationJobRecord.user_id == record.user_id,
        WholeBookTranslationJobRecord.book_id == record.book_id,
        WholeBookTranslationJobRecord.status == 'review',
        datetime_revision_matches(WholeBookTranslationJobRecord.updated_at, record.updated_at, session.get_bind().dialect.name),
    ).values(updated_at=WholeBookTranslationJobRecord.updated_at).execution_options(synchronize_session=False))
    if result.rowcount != 1:
        raise HTTPException(409, '翻译任务状态正在变化，请刷新后重试')


def _catalog_indexes(record: WholeBookTranslationJobRecord) -> set[int]:
    catalog = record.catalog_json
    if not isinstance(catalog, list) or not catalog:
        raise HTTPException(409, '这份更新译稿缺少可靠的原作目录，暂时不能处理')
    indexes = []
    for item in catalog:
        if not isinstance(item, dict):
            raise HTTPException(409, '这份更新译稿的原作目录有误，暂时不能处理')
        indexes.append(_project_episode_index(item.get('index')))
    if len(set(indexes)) != len(indexes):
        raise HTTPException(409, '这份更新译稿有重复源章，暂时不能处理')
    return set(indexes)


def _validated_draft_chapters(record: WholeBookTranslationJobRecord, settings: Settings):
    expected = _catalog_indexes(record)
    if (record.quality_report_json or {}).get('_workflow_version') != 2:
        for index in expected:
            path = _job_root_path(settings, record.user_id, record.id) / 'translated' / f'{index:05d}.json'
            try:
                checkpoint = _read_json(path)
            except (OSError, ValueError):
                raise HTTPException(409, '这份更新译稿尚不完整，检查点已保留，暂时不能加入原书') from None
            if _project_episode_index(checkpoint.get('index', index)) != index:
                raise HTTPException(409, '这份更新译稿的源章对应有误，暂时不能加入原书')
    try:
        drafts = _read_source_update_draft_chapters(record, settings)
    except (OSError, ValueError, KeyError, TypeError):
        raise HTTPException(409, '这份更新译稿的检查点有误，暂时不能加入原书') from None
    if {chapter.index for chapter in drafts} != expected or len(drafts) != len(expected):
        raise HTTPException(409, '这份更新译稿尚不完整，检查点已保留，暂时不能加入原书')
    if any(not split_paragraphs(chapter.content) for chapter in drafts):
        raise HTTPException(409, '这份更新译稿缺少可读正文，暂时不能加入原书')
    return drafts


class _ProjectSwap:
    """Keep the current project intact until a complete replacement is ready."""
    def __init__(self, current: Path):
        self.current = current
        self.stage = current.parent / f'.{current.name}.{uuid4().hex}.review'
        self.previous = current.parent / f'.{current.name}.{uuid4().hex}.previous'
        self.installed = False

    def prepare(self) -> Path:
        shutil.copytree(self.current, self.stage)
        return self.stage

    def install(self) -> None:
        self.current.replace(self.previous)
        try:
            self.stage.replace(self.current)
        except Exception:
            self.previous.replace(self.current)
            raise
        self.installed = True

    def restore(self) -> None:
        if self.installed:
            self.current.replace(self.stage)
            self.previous.replace(self.current)
            self.installed = False

    def clean(self, committed: bool) -> None:
        for path in (self.stage, self.previous if committed else None):
            if path is None or not path.exists():
                continue
            if path.resolve().parent != self.current.parent.resolve() or path.is_symlink():
                raise ValueError('Invalid temporary project path')
            with suppress(OSError):
                shutil.rmtree(path)


def _finish_storage_cleanup(settings: Settings, user_id: str, job_id: str) -> None:
    try:
        _remove_translation_job_storage(settings, user_id, job_id)
    except OSError:
        # Publication already committed. A cleanup failure must not report a
        # failed acceptance that invites a second publication.
        logger.warning('Source-update checkpoint cleanup deferred', exc_info=True)


def accept_source_update_translation(user_id: str, job_id: str, session: Session, settings: Settings,
    *, public_view: PublicView, automatic: bool = False,
) -> WholeBookTranslationJobPublic | None:
    initial = session.get(WholeBookTranslationJobRecord, job_id)
    if not initial or initial.user_id != user_id or initial.job_kind != 'source_update':
        return None
    if automatic:
        raise HTTPException(409, '更新译稿必须由你确认接受后才能加入原书')
    if not initial.book_id:
        raise HTTPException(409, '这份更新译稿当前不能加入原书')
    book_id = initial.book_id
    with upload_book_processing_lock(settings=settings, book_id=book_id):
        record = _review_record(user_id, job_id, session)
        if record is None:
            return None
        repository = SqlAlchemyBookRepository(session, autocommit=False)
        assets = SqlAlchemyBookAssetRepository(session, autocommit=False)
        book = repository.get_owned(user_id, book_id)
        if book is None:
            raise HTTPException(404, '目标图书不存在')
        from app.modules.translations.overlap import require_worker_target
        require_worker_target(session, record)
        expected = _catalog_indexes(record)
        drafts = _validated_draft_chapters(record, settings)
        if (record.quality_report_json or {}).get('_workflow_version') == 2:
            from app.modules.translation_v2.runner import read_snapshot
            candidate = get_storage_root(settings) / 'translation-v2' / user_id / job_id / 'publication-candidate.json'
            read_snapshot(candidate)
            try:
                _claim_review(record, session)
                record.quality_report_json = {**record.quality_report_json, '_v2_publication_approved': True}
                record.status, record.stage = 'queued', 'packaging'
                record.message = 'V2 · 已确认译稿，正在排队验证和发布 EPUB，无需重新翻译'
                record.error_message, record.lease_owner, record.lease_expires_at = None, None, None
                record.updated_at = datetime.now(timezone.utc)
                session.commit()
            except Exception:
                session.rollback()
                raise
            session.refresh(record)
            return public_view(record, session)
        if record.id == book.id:
            raise HTTPException(409, '更新任务与原书存储标识冲突，暂时不能加入原书')
        project = _translation_project_path(settings, user_id, book.id)
        paths = sorted((project / 'translated').glob('*.json'))
        if not paths:
            raise HTTPException(409, '这本书缺少链接精翻项目，不能安全合并更新译稿')
        try:
            existing = [_read_json(path) for path in paths]
        except (OSError, ValueError):
            raise HTTPException(409, '原书的翻译项目记录有误，暂时不能安全合并译稿') from None
        existing_indexes = {_project_episode_index(chapter.get('index', path.stem))
            for path, chapter in zip(paths, existing, strict=True) if not path.stem.startswith('local-')}
        if expected.intersection(existing_indexes):
            raise HTTPException(409, '原书已经包含这批更新，请刷新任务状态')
        chapters = [{'index':chapter.index,'title':chapter.title,'source_title':chapter.source_title,
            'source_url':chapter.source_url,'paragraphs':split_paragraphs(chapter.content)} for chapter in drafts]
        if not book.original_file_path:
            raise HTTPException(409, '原书文件不存在')
        original = resolve_storage_path(get_storage_root(settings), book.original_file_path)
        if book.reader_type == 'epub' and original.suffix.lower() == '.epub':
            sidecars = _manual_epub_sidecar_chapters(book=book, asset_repository=assets, draft_chapters=chapters, settings=settings)
            rebuilt = append_translation_epub(original_epub=original.read_bytes(), chapters=[*sidecars,*chapters])
        elif book.reader_type == 'text' and original.suffix.lower() == '.txt':
            # The live TXT can include edits and manual additions newer than
            # archived checkpoints. Append to its decoded text, retaining them.
            addition = build_translation_txt(chapters=chapters).decode('utf-8')
            rebuilt = (decode_text(original.read_bytes()).rstrip() + '\n\n' + addition).encode('utf-8')
        else:
            raise HTTPException(409, '原书不是可安全重建的 EPUB 或 TXT')
        candidate = _job_root_path(settings, user_id, job_id) / ('publication-candidate' + original.suffix.lower())
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_bytes(rebuilt)
        candidate_relative = candidate.relative_to(get_storage_root(settings)).as_posix()
        swap = _ProjectSwap(project)
        committed = False
        try:
            staged_project = swap.prepare()
            _merge_source_update_project(staged_project, record, settings)
            from app.modules.reader.service import filter_readable_text_assets
            from app.modules.reading_progress.chapter_calculation import appended_progress_percent, rebase_appended_progress
            from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository
            previous = filter_readable_text_assets(assets.list_by_book(book_id, 'text_chapter'))
            published = publish_staged_replacement(owner_id=user_id, book=book,
                processing_book=book.with_changes(original_file_path=candidate_relative, file_size=len(rebuilt)),
                task_id=job_id, session=session, asset_repository=assets, book_repository=repository,
                settings=settings, processor=run_processor)
            current = filter_readable_text_assets(assets.list_by_book(book_id, 'text_chapter'))
            repository.save(published.with_changes(progress_percent=appended_progress_percent(book.progress_percent, previous, current)))
            rebase_appended_progress(book_id, previous, current, SqlAlchemyReadingProgressRepository(session, autocommit=False))
            _claim_review(record, session)
            # Resolve the target and related books once in this transaction.
            resolve_matching_source_update_episodes(owner_id=user_id, source_url=record.source_url,
                resolved_indexes=expected, book_repository=repository)
            swap.install()
            record.status = record.stage = 'ready'
            record.message = f'已确认并加入 {len(chapters)} 话，原文件与目录已更新'
            record.acknowledged = False
            record.updated_at = datetime.now(timezone.utc)
            session.commit()
            committed = True
        except Exception:
            session.rollback()
            swap.restore()
            raise
        finally:
            swap.clean(committed)
        session.refresh(record)
        _finish_storage_cleanup(settings, user_id, job_id)
        return public_view(record, session)


def reject_source_update_translation(user_id: str, job_id: str, session: Session, settings: Settings,
    *, public_view: PublicView,
) -> WholeBookTranslationJobPublic | None:
    initial = session.get(WholeBookTranslationJobRecord, job_id)
    if not initial or initial.user_id != user_id or initial.job_kind != 'source_update':
        return None
    if not initial.book_id:
        raise HTTPException(409, '这份更新译稿当前不能放弃')
    book_id = initial.book_id
    with upload_book_processing_lock(settings=settings, book_id=book_id):
        record = _review_record(user_id, job_id, session)
        if record is None:
            return None
        indexes = _catalog_indexes(record)
        project = _translation_project_path(settings, user_id, book_id)
        manifest = project / 'project.json'
        if not manifest.is_file():
            raise HTTPException(409, '这本书缺少链接精翻项目，不能记录放弃决定')
        # Dismissal changes one small manifest; no chapter tree copy is needed.
        original_manifest = manifest.read_bytes()
        stage = project.parent / f'.{project.name}.{uuid4().hex}.dismiss'
        stage.mkdir()
        (stage / 'project.json').write_bytes(original_manifest)
        installed = False
        try:
            _mark_source_update_episodes_dismissed(stage, record)
            _claim_review(record, session)
            repository = SqlAlchemyBookRepository(session, autocommit=False)
            resolve_matching_source_update_episodes(owner_id=user_id, source_url=record.source_url,
                resolved_indexes=indexes, book_repository=repository)
            (stage / 'project.json').replace(manifest)
            installed = True
            record.status = record.stage = 'rejected'
            record.message = '已放弃这批更新译稿，原书未修改'
            record.acknowledged = True
            record.updated_at = datetime.now(timezone.utc)
            session.commit()
        except Exception:
            session.rollback()
            if installed:
                temporary = stage / 'project.json'
                temporary.write_bytes(original_manifest)
                temporary.replace(manifest)
            raise
        finally:
            if stage.resolve().parent != project.parent.resolve() or stage.is_symlink():
                raise ValueError('Invalid temporary dismissal path')
            with suppress(OSError):
                shutil.rmtree(stage)
        session.refresh(record)
        _finish_storage_cleanup(settings, user_id, job_id)
        return public_view(record, session)
