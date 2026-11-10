from collections.abc import Callable
from datetime import datetime, timezone
import logging
import mimetypes
from pathlib import Path
from typing import cast
from uuid import uuid4

from fastapi import HTTPException, UploadFile, status

from app.core.config import Settings
from app.core.storage import StorageLimitExceededError, get_storage_root, resolve_storage_path, save_original_upload, write_upload_file
from app.modules.book_assets.repository import BookAssetRepository, SqlAlchemyBookAssetRepository
from app.modules.books.repository import BookRepository, SqlAlchemyBookRepository
from app.modules.processing.service import process_uploaded_book, run_processor
from app.modules.uploads.domain import UploadStatus, UploadTask, UploadTaskKind
from app.modules.uploads.repository import SqlAlchemyUploadTaskRepository, UploadTaskRepository
from app.modules.uploads.schemas import UploadBookResponse, UploadTaskPublic
from app.modules.uploads.chapter_preservation import preserve_manual_chapters, restore_manual_chapters
from app.modules.uploads.replacement_publication import publish_staged_replacement, publish_staged_reprocess, update_replacement_reading_state
from app.modules.uploads.replacement_storage import upload_book_processing_lock, replacement_candidate_relative_path, replacement_version_relative_path, cleanup_replacement_task, remove_processed_upload_storage

logger = logging.getLogger(__name__)

FORMAT_META: dict[str, tuple[str, str, str]] = {
    ".avif": ("AVIF", "image", "image"),
    ".bmp": ("BMP", "image", "image"),
    ".cbz": ("CBZ", "manga", "comic"),
    ".epub": ("EPUB", "novel", "epub"),
    ".gif": ("GIF", "image", "image"),
    ".jfif": ("JFIF", "image", "image"),
    ".jpeg": ("JPEG", "image", "image"),
    ".jpg": ("JPG", "image", "image"),
    ".mobi": ("MOBI", "novel", "text"),
    ".pdf": ("PDF", "pdf", "pdf"),
    ".png": ("PNG", "image", "image"),
    ".txt": ("TXT", "novel", "text"),
    ".webp": ("WEBP", "image", "image"),
    ".zip": ("ZIP", "manga", "comic"),
}

SessionFactory = Callable[[], object]


async def create_upload_task_from_file(
    *,
    owner_id: str,
    file: UploadFile,
    title: str | None,
    author: str | None,
    description: str | None,
    publication_status: str | None,
    source_url: str | None,
    tags: str | None,
    settings: Settings,
    book_repository: BookRepository,
    upload_task_repository: UploadTaskRepository,
    book_id: str | None = None,
    external_import: bool = False,
) -> UploadBookResponse:
    extension = Path(file.filename or "").suffix.lower()
    format_meta = FORMAT_META.get(extension)

    if not format_meta:
        task = save_upload_task(
            owner_id=owner_id,
            book_id=None,
            file_name=file.filename or "unknown",
            file_type=extension.lstrip(".").upper() or "UNKNOWN",
            file_size=0,
            status_value="failed",
            progress=0,
            message="不支持的文件格式",
            error_code="unsupported_format",
            upload_task_repository=upload_task_repository,
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"task_id": task.id, "error_code": "unsupported_format"})

    book_id = book_id or str(uuid4())
    try:
        stored_file = await save_original_upload(book_id=book_id, owner_id=owner_id, settings=settings, upload_file=file)
    except StorageLimitExceededError as error:
        task = save_upload_task(
            owner_id=owner_id,
            book_id=None,
            file_name=file.filename or "unknown",
            file_type=format_meta[0],
            file_size=0,
            status_value="failed",
            progress=0,
            message=str(error),
            error_code="file_too_large",
            upload_task_repository=upload_task_repository,
        )
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail={"task_id": task.id, "error_code": "file_too_large"})

    file_label, kind, reader_type = format_meta
    tag_tuple = tuple(item.strip() for item in (tags or "").split(",") if item.strip())
    book = book_repository.create_from_upload(
        owner_id=owner_id,
        book_id=book_id,
        title=title or build_default_title(file.filename, tag_tuple, file_label),
        author=author or "未知作者",
        tags=tag_tuple or ("本地上传", file_label),
        file_label=file_label,
        file_ext=extension,
        file_size=stored_file.size,
        kind=kind,
        mime_type=file.content_type,
        original_file_path=stored_file.relative_path,
        reader_type=reader_type,
    )
    metadata_changes: dict[str, object] = {}
    if external_import:
        metadata_changes["auto_translate_updates"] = False
    if description and description.strip():
        metadata_changes["description"] = description.strip()
    if source_url and source_url.strip():
        metadata_changes["source_url"] = source_url.strip()
    if publication_status in {"ongoing", "completed"}:
        metadata_changes["publication_status"] = publication_status
    if metadata_changes:
        book = book_repository.save(book.with_changes(**metadata_changes))
    task = save_upload_task(
        owner_id=owner_id,
        book_id=book.id,
        file_name=file.filename or "unknown",
        file_type=file_label,
        file_size=stored_file.size,
        kind="initial",
        status_value="processing",
        progress=72,
        message="原文件已保存，等待后台解析。",
        error_code=None,
        upload_task_repository=upload_task_repository,
    )

    return UploadBookResponse(book_id=book.id, task_id=task.id, status=task.status)


def create_reprocess_task_for_book(
    *,
    owner_id: str,
    book_id: str,
    book_repository: BookRepository,
    upload_task_repository: UploadTaskRepository,
    task_id: str | None = None,
) -> UploadBookResponse | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None
    if not book.original_file_path:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Book has no original file to reprocess")

    guard_file_operation(owner_id=owner_id, book_id=book.id, upload_task_repository=upload_task_repository)

    task = save_upload_task(
        task_id=task_id,
        owner_id=owner_id,
        book_id=book.id,
        file_name=book.title,
        file_type=get_file_type_from_extension(book.file_ext),
        file_size=book.file_size or 0,
        # Marks the task for the external worker: reprocess runs must not let
        # embedded file metadata overwrite manually edited book fields.
        kind="reprocess",
        status_value="processing",
        progress=12,
        message="正在重新解析原文件",
        error_code=None,
        upload_task_repository=upload_task_repository,
    )
    return UploadBookResponse(book_id=book.id, task_id=task.id, status=task.status)


async def create_replace_task_for_book(
    *,
    owner_id: str,
    book_id: str,
    file: UploadFile,
    keep_progress: bool,
    settings: Settings,
    book_repository: BookRepository,
    upload_task_repository: UploadTaskRepository,
    task_id: str | None = None,
) -> UploadBookResponse | None:
    book = book_repository.get_owned(owner_id, book_id)
    if not book:
        return None
    if book.status in {"uploading", "processing"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Book is already being processed")

    extension = Path(file.filename or "").suffix.lower()
    format_meta = FORMAT_META.get(extension)
    if not format_meta:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported replacement format")

    task_id = task_id or str(uuid4())
    candidate_relative = replacement_candidate_relative_path(owner_id=owner_id, book_id=book.id, task_id=task_id, extension=extension)
    try:
        stored_file = await write_upload_file(settings=settings, upload_file=file, relative_path=candidate_relative)
    except StorageLimitExceededError as error:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(error)) from error

    try:
        guard_file_operation(owner_id=owner_id, book_id=book.id, upload_task_repository=upload_task_repository)
    except Exception:
        cleanup_replacement_task(owner_id=owner_id, book_id=book.id, task_id=task_id, settings=settings)
        raise
    task = save_upload_task(
        task_id=task_id,
        owner_id=owner_id,
        book_id=book.id,
        file_name=file.filename or f"replacement{extension}",
        file_type=format_meta[0],
        file_size=stored_file.size,
        kind="replace_keep_progress" if keep_progress else "replace_reset_progress",
        status_value="processing",
        progress=72,
        message="新文件已保存，等待安全替换。",
        error_code=None,
        upload_task_repository=upload_task_repository,
    )
    return UploadBookResponse(book_id=book.id, task_id=task.id, status=task.status)


def guard_file_operation(*, owner_id: str, book_id: str, upload_task_repository: UploadTaskRepository) -> None:
    session = getattr(upload_task_repository, "_session", None)
    if session is not None:
        from app.modules.books.continuation import lock_owned_book
        lock_owned_book(session, owner_id, book_id)
        from app.modules.translations.overlap import require_external_write_available
        require_external_write_available(session, owner_id, book_id, allow_stopped_file_operation=True)
    active = upload_task_repository.find_processing_for_book(owner_id, book_id)
    if active:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
            "error_code": "book_processing", "task_id": active.id, "book_id": book_id,
            "task_kind": active.kind,
            "message": "这本书已有文件处理任务，请先查看处理结果。",
        })


def process_upload_task(
    *,
    book_id: str | None,
    owner_id: str,
    settings: Settings,
    should_update_metadata: bool = True,
    session_factory: SessionFactory,
    task_id: str,
) -> None:
    if not book_id:
        return _process_upload_task_unlocked(
            book_id=book_id,
            owner_id=owner_id,
            settings=settings,
            should_update_metadata=should_update_metadata,
            session_factory=session_factory,
            task_id=task_id,
        )
    with upload_book_processing_lock(settings=settings, book_id=book_id):
        return _process_upload_task_unlocked(
            book_id=book_id,
            owner_id=owner_id,
            settings=settings,
            should_update_metadata=should_update_metadata,
            session_factory=session_factory,
            task_id=task_id,
        )


def _process_upload_task_unlocked(
    *,
    book_id: str | None,
    owner_id: str,
    settings: Settings,
    should_update_metadata: bool = True,
    session_factory: SessionFactory,
    task_id: str,
) -> None:
    with session_factory() as session:
        asset_repository = SqlAlchemyBookAssetRepository(session)
        book_repository = SqlAlchemyBookRepository(session)
        upload_task_repository = SqlAlchemyUploadTaskRepository(session)
        initial_task = upload_task_repository.get_owned(owner_id, task_id)
        if initial_task and initial_task.status != "processing":
            return
        if not book_id:
            existing_task = initial_task
            if existing_task:
                save_upload_task(
                    task_id=task_id,
                    created_at=existing_task.created_at,
                    owner_id=owner_id,
                    book_id=None,
                    file_name=existing_task.file_name,
                    file_type=existing_task.file_type,
                    file_size=existing_task.file_size,
                    kind=existing_task.kind,
                    status_value="failed",
                    progress=0,
                    message="上传任务缺少书籍记录，无法继续解析。",
                    error_code="book_not_found",
                    upload_task_repository=upload_task_repository,
                )
            return

        book = book_repository.get_owned(owner_id, book_id)
        if not book:
            existing_task = upload_task_repository.get_owned(owner_id, task_id)
            if existing_task:
                save_upload_task(
                    task_id=task_id,
                    created_at=existing_task.created_at,
                    owner_id=owner_id,
                    book_id=existing_task.book_id or book_id,
                    file_name=existing_task.file_name,
                    file_type=existing_task.file_type,
                    file_size=existing_task.file_size,
                    kind=existing_task.kind,
                    status_value="failed",
                    progress=0,
                    message="书籍记录已不存在，无法继续解析。",
                    error_code="book_not_found",
                    upload_task_repository=upload_task_repository,
                )
            return

        existing_task = upload_task_repository.get_owned(owner_id, task_id)
        replacement_kind = existing_task.kind if existing_task and existing_task.kind.startswith("replace_") else None
        reprocess_kind = existing_task is not None and existing_task.kind == "reprocess"
        processing_book = book
        replacement_published = False

        if reprocess_kind:
            format_meta = FORMAT_META.get((book.file_ext or "").lower())
            processing_book = book.with_changes(
                kind=format_meta[1] if format_meta else book.kind,
                reader_type=format_meta[2] if format_meta else "unsupported",
                status="processing",
            )

        if replacement_kind and existing_task:
            extension = Path(existing_task.file_name).suffix.lower()
            format_meta = FORMAT_META.get(extension)
            candidate_relative = replacement_candidate_relative_path(owner_id=owner_id, book_id=book.id, task_id=task_id, extension=extension)
            candidate_path = resolve_storage_path(get_storage_root(settings), candidate_relative)
            if not format_meta or not candidate_path.is_file():
                save_upload_task(
                    task_id=task_id,
                    created_at=existing_task.created_at,
                    owner_id=owner_id,
                    book_id=book.id,
                    file_name=existing_task.file_name,
                    file_type=existing_task.file_type,
                    file_size=existing_task.file_size,
                    kind=existing_task.kind,
                    status_value="failed",
                    progress=0,
                    message="替换文件不存在或格式无效，旧版本未受影响。",
                    error_code="replacement_missing",
                    upload_task_repository=upload_task_repository,
                )
                return
            processing_book = book.with_changes(
                file_ext=extension,
                file_size=existing_task.file_size,
                kind=format_meta[1],
                mime_type=mimetypes.guess_type(existing_task.file_name)[0],
                original_file_path=candidate_relative.as_posix(),
                reader_type=format_meta[2],
                status="processing",
            )

        try:
            if replacement_kind:
                expected_original = replacement_version_relative_path(
                    owner_id=owner_id, book_id=book.id, task_id=task_id, extension=processing_book.file_ext or ""
                ).as_posix()
                processed_book = (
                    book if book.original_file_path == expected_original else publish_staged_replacement(
                        owner_id=owner_id,
                        book=book,
                        processing_book=processing_book,
                        task_id=task_id,
                        session=session,
                        asset_repository=asset_repository,
                        book_repository=book_repository,
                        settings=settings,
                        processor=run_processor,
                    )
                )
                replacement_published = True
                update_replacement_reading_state(
                    asset_repository=asset_repository,
                    owner_id=owner_id,
                    book_id=book.id,
                    reader_type=processed_book.reader_type,
                    keep_progress=replacement_kind == "replace_keep_progress",
                    session=session,
                )
            elif reprocess_kind:
                processed_book = publish_staged_reprocess(
                    owner_id=owner_id,
                    book=book,
                    processing_book=processing_book,
                    task_id=task_id,
                    session=session,
                    asset_repository=asset_repository,
                    book_repository=book_repository,
                    settings=settings,
                    processor=run_processor,
                )
            else:
                manual_chapters = preserve_manual_chapters(owner_id=owner_id, book_id=book.id, asset_repository=asset_repository, settings=settings)
                remove_processed_upload_storage(owner_id=owner_id, book_id=book.id, settings=settings)
                processed_book = process_uploaded_book(
                    asset_repository=asset_repository,
                    book=processing_book,
                    book_repository=book_repository,
                    should_update_author=should_update_metadata,
                    should_update_title=should_update_metadata,
                    should_update_description=should_update_metadata,
                    settings=settings,
                )
                processed_book = restore_manual_chapters(
                    asset_repository=asset_repository,
                    book_repository=book_repository,
                    chapters=manual_chapters,
                    processed_book=processed_book,
                )
        except Exception as error:
            session.rollback()
            # The raw exception may leak internal paths; keep the user-facing
            # message stable and record the details in the server log instead.
            logger.exception("Processing upload task %s for book %s failed: %r", task_id, book.id, error)
            if reprocess_kind:
                published_task = upload_task_repository.get_owned(owner_id, task_id)
                if published_task and published_task.status == "ready":
                    return
                remove_processed_upload_storage(owner_id=owner_id, book_id=task_id, settings=settings)
                save_upload_task(
                    task_id=task_id,
                    created_at=existing_task.created_at if existing_task else None,
                    owner_id=owner_id,
                    book_id=book.id,
                    file_name=existing_task.file_name if existing_task else book.title,
                    file_type=existing_task.file_type if existing_task else get_file_type_from_extension(book.file_ext),
                    file_size=book.file_size or 0,
                    kind="reprocess",
                    status_value="failed",
                    progress=0,
                    message="重新解析失败，旧章节仍可阅读。",
                    error_code="processing_failed",
                    upload_task_repository=upload_task_repository,
                )
                return
            if replacement_kind:
                published_book = book_repository.get_owned(owner_id, book.id)
                replacement_published = replacement_published or (
                    published_book is not None
                    and published_book.original_file_path == replacement_version_relative_path(
                        owner_id=owner_id, book_id=book.id, task_id=task_id, extension=processing_book.file_ext or ""
                    ).as_posix()
                )
                if not replacement_published:
                    version_relative = replacement_version_relative_path(
                        owner_id=owner_id, book_id=book.id, task_id=task_id, extension=processing_book.file_ext or ""
                    )
                    resolve_storage_path(get_storage_root(settings), version_relative).unlink(missing_ok=True)
                    remove_processed_upload_storage(owner_id=owner_id, book_id=task_id, settings=settings)
                    cleanup_replacement_task(owner_id=owner_id, book_id=book.id, task_id=task_id, settings=settings)
                existing_task = upload_task_repository.get_owned(owner_id, task_id)
                save_upload_task(
                    task_id=task_id,
                    created_at=existing_task.created_at if existing_task else None,
                    owner_id=owner_id,
                    book_id=book.id,
                    file_name=existing_task.file_name if existing_task else book.title,
                    file_type=existing_task.file_type if existing_task else get_file_type_from_extension(book.file_ext),
                    file_size=existing_task.file_size if existing_task else (book.file_size or 0),
                    kind=existing_task.kind if existing_task else "replace_keep_progress",
                    status_value="failed",
                    progress=0,
                    message="新文件解析失败，旧版本仍可阅读。" if not replacement_published else "新版本已发布，但阅读进度更新失败，请重新打开书籍。",
                    error_code="processing_failed",
                    upload_task_repository=upload_task_repository,
                )
                return

            custom_cover = next(
                (
                    asset
                    for asset in asset_repository.list_by_book(book.id, "cover")
                    if asset.metadata.get("source") == "user_upload"
                ),
                None,
            )
            asset_repository.clear_for_book(book.id)
            remove_processed_upload_storage(owner_id=owner_id, book_id=book.id, settings=settings)
            preserved_assets = manual_chapters if "manual_chapters" in locals() else []
            if custom_cover:
                preserved_assets = [*preserved_assets, custom_cover]
            if preserved_assets:
                asset_repository.save_many(preserved_assets)
            book_repository.save(book.with_changes(cover_url=book.cover_url if custom_cover else None, current_chapter=None, hero_image_url=None, status="failed", reader_type="unsupported"))
            existing_task = upload_task_repository.get_owned(owner_id, task_id)
            save_upload_task(
                task_id=task_id,
                created_at=existing_task.created_at if existing_task else None,
                owner_id=owner_id,
                book_id=book.id,
                file_name=existing_task.file_name if existing_task else book.title,
                file_type=existing_task.file_type if existing_task else get_file_type_from_extension(book.file_ext),
                file_size=book.file_size or 0,
                kind=existing_task.kind if existing_task else "initial",
                status_value="failed",
                progress=0,
                message="文件处理失败，请重试或更换文件。",
                error_code="processing_failed",
                upload_task_repository=upload_task_repository,
            )
            return

        existing_task = upload_task_repository.get_owned(owner_id, task_id)
        is_ready = processed_book.status != "failed"
        success_message = build_processing_message(book.id, asset_repository)
        if replacement_kind:
            progress_message = "阅读进度已按百分比保留" if replacement_kind == "replace_keep_progress" else "阅读进度已重置"
            success_message = f"新文件替换完成，阅读时长已保留，{progress_message}，旧书签与备注已清除。"
        save_upload_task(
            task_id=task_id,
            created_at=existing_task.created_at if existing_task else None,
            owner_id=owner_id,
            book_id=book.id,
            file_name=existing_task.file_name if existing_task else book.title,
            file_type=existing_task.file_type if existing_task else get_file_type_from_extension(book.file_ext),
            file_size=processed_book.file_size or 0,
            kind=existing_task.kind if existing_task else "initial",
            status_value="ready" if is_ready else "failed",
            progress=100 if is_ready else 0,
            message=success_message if is_ready else "文件已保存，但当前格式暂不支持在线解析。",
            error_code=None if is_ready else "unsupported_format",
            upload_task_repository=upload_task_repository,
        )
        if replacement_kind:
            cleanup_replacement_task(owner_id=owner_id, book_id=book.id, task_id=task_id, settings=settings)


def build_default_title(file_name: str | None, tags: tuple[str, ...], file_label: str) -> str:
    title = Path(file_name or "未命名图书").stem
    if not title.isdigit():
        return title

    series_tag = next((tag for tag in tags if is_series_title_tag(tag, file_label)), None)
    return f"{series_tag} {title}" if series_tag else title


def get_file_type_from_extension(file_ext: str | None) -> str:
    if not file_ext:
        return "UNKNOWN"

    format_meta = FORMAT_META.get(file_ext.lower())
    return format_meta[0] if format_meta else file_ext.lstrip(".").upper()


def is_series_title_tag(tag: str, file_label: str) -> bool:
    normalized_tag = tag.strip()
    if not normalized_tag:
        return False

    return normalized_tag not in {"本地导入", "本地上传", file_label, file_label.lower(), file_label.upper()}


def build_processing_message(book_id: str, asset_repository: BookAssetRepository) -> str:
    assets = asset_repository.list_by_book(book_id)
    cover_count = sum(1 for asset in assets if asset.asset_type == "cover")
    chapter_count = sum(1 for asset in assets if asset.asset_type == "text_chapter")
    chapter_image_count = sum(1 for asset in assets if asset.asset_type == "chapter_image")
    page_count = sum(1 for asset in assets if asset.asset_type in {"comic_page", "image_page"})
    parts = ["已保存原文件"]

    if cover_count:
        parts.append(f"封面 {cover_count} 张")
    if chapter_count:
        parts.append(f"正文 {chapter_count} 章")
    if chapter_image_count:
        parts.append(f"插图 {chapter_image_count} 张")
    if page_count:
        parts.append(f"图片页 {page_count} 页")
    if len(parts) == 1:
        parts.append("暂无可提取的在线阅读资产")

    return "，".join(parts) + "。"


def list_tasks(user_id: str, upload_task_repository: UploadTaskRepository) -> list[UploadTaskPublic]:
    return [to_public(task) for task in upload_task_repository.list_by_user(user_id)]


def get_task(user_id: str, task_id: str, upload_task_repository: UploadTaskRepository) -> UploadTaskPublic | None:
    task = upload_task_repository.get_owned(user_id, task_id)
    return to_public(task) if task else None


def clear_finished_tasks(user_id: str, upload_task_repository: UploadTaskRepository) -> int:
    return upload_task_repository.delete_finished_for_user(user_id)


def save_upload_task(
    *,
    task_id: str | None = None,
    created_at: datetime | None = None,
    owner_id: str,
    book_id: str | None,
    file_name: str,
    file_type: str,
    file_size: int,
    kind: str = "initial",
    status_value: str,
    progress: int,
    message: str | None,
    error_code: str | None,
    upload_task_repository: UploadTaskRepository,
) -> UploadTask:
    now = datetime.now(timezone.utc)
    return upload_task_repository.save(
        UploadTask(
            id=task_id or str(uuid4()),
            user_id=owner_id,
            book_id=book_id,
            file_name=file_name,
            file_type=file_type,
            file_size=file_size,
            kind=cast(UploadTaskKind, kind),
            status=cast(UploadStatus, status_value),
            progress=progress,
            message=message,
            error_code=error_code,
            created_at=created_at or now,
            updated_at=now,
        )
    )


def to_public(task: UploadTask) -> UploadTaskPublic:
    return UploadTaskPublic(
        id=task.id,
        book_id=task.book_id,
        file_name=task.file_name,
        file_type=task.file_type,
        file_size=task.file_size,
        status=task.status,
        progress=task.progress,
        message=task.message,
        error_code=task.error_code,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )
