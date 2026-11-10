from collections.abc import Callable
from dataclasses import replace
from datetime import datetime, timezone
import os
import shutil
from sqlalchemy import or_, update

from app.core.config import Settings
from app.core.database_revisions import datetime_revision_matches
from app.core.storage import get_storage_root, resolve_storage_path
from app.modules.book_assets.repository import BookAssetRepository, asset_to_record
from app.modules.books.domain import Book
from app.modules.books.models import BookRecord
from app.modules.books.repository import BookRepository
from app.modules.processing.types import ProcessingResult
from app.modules.processing.service import validate_replacement_processing_result
from app.modules.reader.service import filter_readable_text_assets, get_reader_progress_weight, resolve_progress_chapter_position
from app.modules.reader_marks.models import ReaderMarkRecord
from app.modules.reader.page_identity import pdf_position_key
from app.modules.reading_progress.repository import SqlAlchemyReadingProgressRepository
from app.modules.uploads.chapter_preservation import preserve_external_source_identity, preserve_manual_chapters
from app.modules.uploads.models import UploadTaskRecord
from app.modules.uploads.replacement_storage import replacement_version_relative_path


def publish_staged_replacement(
    *, owner_id: str, book: Book, processing_book: Book, task_id: str, session,
    asset_repository: BookAssetRepository, book_repository: BookRepository, settings: Settings,
    processor: Callable[[Book, Settings], ProcessingResult],
) -> Book:
    """Parse under a private ID, then switch all reader references in one DB commit."""
    storage_root = get_storage_root(settings)
    staged_book = processing_book.with_changes(id=task_id)
    result = processor(staged_book, settings)
    validate_replacement_processing_result(processing_book, result, settings)

    version_relative = replacement_version_relative_path(
        owner_id=owner_id, book_id=book.id, task_id=task_id, extension=processing_book.file_ext or ""
    )
    version_path = resolve_storage_path(storage_root, version_relative)
    version_path.parent.mkdir(parents=True, exist_ok=True)
    candidate_path = resolve_storage_path(storage_root, processing_book.original_file_path or "")
    staged_original = version_path.with_name(f".{version_path.name}.staging")
    try:
        shutil.copy2(candidate_path, staged_original)
        os.replace(staged_original, version_path)
    finally:
        staged_original.unlink(missing_ok=True)

    custom_cover = next(
        (asset for asset in asset_repository.list_by_book(book.id, "cover") if asset.metadata.get("source") == "user_upload"),
        None,
    )
    new_assets = [replace(asset, book_id=book.id) for asset in result.assets]
    if custom_cover:
        new_assets.append(custom_cover)
    updated_book = processing_book.with_changes(
        original_file_path=version_relative.as_posix(),
        reader_type=result.reader_type or processing_book.reader_type,
        kind="manga" if result.reader_type == "comic" else processing_book.kind,
        cover_url=book.cover_url if custom_cover else (f"/api/v1/files/books/{book.id}/cover" if result.cover_path else None),
        hero_image_url=None,
        current_chapter=result.current_chapter,
        language=book.resolve_processed_language(result.language),
        language_mode=book.effective_language_mode,
        status="ready",
    )
    # Claim this exact book revision after parsing. The conditional UPDATE takes
    # the SQLite writer lock until the asset swap commits, so a concurrent edit
    # or deletion cannot be silently overwritten by an old parser snapshot.
    claim_book_revision(session=session, book=book, owner_id=owner_id)
    retire_reader_mark_positions(session=session, book_id=book.id)
    asset_repository.clear_for_book(book.id, commit=False)
    session.add_all([asset_to_record(asset) for asset in new_assets])
    return book_repository.save(updated_book)


def publish_staged_reprocess(
    *, owner_id: str, book: Book, processing_book: Book, task_id: str, session,
    asset_repository: BookAssetRepository, book_repository: BookRepository, settings: Settings,
    processor: Callable[[Book, Settings], ProcessingResult],
) -> Book:
    """Reparse under a private resource ID and commit the catalog and task together."""
    staged_book = processing_book.with_changes(id=task_id)
    result = processor(staged_book, settings)
    validate_replacement_processing_result(processing_book, result, settings)
    previous_chapters = filter_readable_text_assets(asset_repository.list_by_book(book.id, "text_chapter"))
    manual_chapters = preserve_manual_chapters(
        owner_id=owner_id, book_id=book.id, asset_repository=asset_repository, settings=settings
    )
    custom_cover = next(
        (asset for asset in asset_repository.list_by_book(book.id, "cover") if asset.metadata.get("source") == "user_upload"),
        None,
    )
    new_assets = [replace(asset, book_id=book.id) for asset in result.assets]
    new_assets = preserve_external_source_identity(new_assets, asset_repository.list_by_book(book.id, "text_chapter"), settings)
    next_index = max((asset.index or 0 for asset in new_assets if asset.asset_type == "text_chapter"), default=0) + 1
    restored_manual = [replace(asset, index=next_index + offset) for offset, asset in enumerate(manual_chapters)]
    new_assets.extend(restored_manual)
    if custom_cover:
        new_assets.append(custom_cover)
    last_manual_title = restored_manual[-1].metadata.get("title") if restored_manual else None
    updated_book = book.with_changes(
        file_size=resolve_storage_path(get_storage_root(settings), book.original_file_path or "").stat().st_size,
        kind="manga" if result.reader_type == "comic" else processing_book.kind,
        reader_type=result.reader_type or processing_book.reader_type,
        cover_url=book.cover_url if custom_cover else (f"/api/v1/files/books/{book.id}/cover" if result.cover_path else None),
        hero_image_url=None,
        current_chapter=last_manual_title if isinstance(last_manual_title, str) else result.current_chapter,
        language=book.resolve_processed_language(result.language),
        language_mode=book.effective_language_mode,
        status="ready",
    )
    claim_book_revision(session=session, book=book, owner_id=owner_id)
    if updated_book.reader_type in {"text", "epub"}:
        current_chapters = filter_readable_text_assets(sorted(
            [asset for asset in new_assets if asset.asset_type == "text_chapter"], key=lambda asset: asset.index or 0))
        # Reprocessing an externally appended original is an append only when
        # every old chapter is still the exact prefix, not an edited edition.
        if len(current_chapters) > len(previous_chapters) and previous_chapters:
            from app.modules.books.chapter_append import get_asset_title, read_asset_content_hash
            from app.modules.reading_progress.chapter_calculation import appended_progress_percent, rebase_appended_progress
            hashes = [(read_asset_content_hash(old.path, settings, get_asset_title(old, index)),
                       read_asset_content_hash(new.path, settings, get_asset_title(new, index)))
                      for index, (old, new) in enumerate(zip(previous_chapters, current_chapters), 1)]
            if all(old is not None and old == new for old, new in hashes):
                updated_book = updated_book.with_changes(progress_percent=appended_progress_percent(book.progress_percent, previous_chapters, current_chapters))
                rebase_appended_progress(book.id, previous_chapters, current_chapters,
                                        SqlAlchemyReadingProgressRepository(session, autocommit=False))
    valid_keys = set()
    if updated_book.reader_type in {"text", "epub"}:
        valid_keys = {asset.id for asset in filter_readable_text_assets([asset for asset in new_assets if asset.asset_type == "text_chapter"])}
    elif updated_book.reader_type in {"comic", "image"}:
        page_type = "comic_page" if updated_book.reader_type == "comic" else "image_page"
        valid_keys = {asset.id for asset in new_assets if asset.asset_type == page_type}
    if updated_book.reader_type == "pdf":
        valid_keys = {key} if (key := pdf_position_key(updated_book)) else set()
    retire_reader_mark_positions(session=session, book_id=book.id, valid_keys=valid_keys, reader_type=updated_book.reader_type)
    asset_repository.clear_for_book(book.id, commit=False)
    session.add_all([asset_to_record(asset) for asset in new_assets])
    task_record = session.get(UploadTaskRecord, task_id)
    if task_record is None:
        raise ValueError("Reprocess task disappeared before publication")
    task_record.status = "ready"
    task_record.progress = 100
    task_record.error_code = None
    task_record.message = "重新解析完成"
    task_record.updated_at = datetime.now(timezone.utc)
    return book_repository.save(updated_book)


def claim_book_revision(*, session, book: Book, owner_id: str) -> None:
    # Acquire the writer lock without changing the revision: the repository's
    # final save checks that same snapshot and advances it atomically.
    claimed = session.execute(
        update(BookRecord)
        .where(
            BookRecord.id == book.id,
            BookRecord.owner_id == owner_id,
            BookRecord.status != "deleted",
            datetime_revision_matches(BookRecord.updated_at, book.updated_at, session.get_bind().dialect.name),
        )
        .values(updated_at=BookRecord.updated_at)
        .execution_options(synchronize_session=False)
    )
    if claimed.rowcount != 1:
        session.rollback()
        raise ValueError("Book changed while processing; old version remains current")


def update_replacement_reading_state(
    *,
    asset_repository: BookAssetRepository,
    owner_id: str,
    book_id: str,
    reader_type: str,
    keep_progress: bool,
    session,
) -> None:
    progress_repository = SqlAlchemyReadingProgressRepository(session, autocommit=False)
    progresses = progress_repository.list_all_for_book(book_id)
    # Replacing the underlying file changes the coordinate system for every
    # reader of a shared book. Keep each reader's own percentage when requested.
    for current_progress in progresses:
        if not keep_progress:
            progress_repository.delete_for_book(current_progress.user_id, book_id, commit=False)
            continue
        chapter_index, chapter_ratio = resolve_replacement_chapter_position(
            asset_repository=asset_repository,
            book_id=book_id,
            progress_percent=current_progress.progress_percent,
            reader_type=reader_type,
        )
        progress_repository.save(
            replace(
                current_progress,
                reader_type=reader_type,
                chapter_index=chapter_index,
                page_number=None,
                image_index=None,
                chapter_href=None,
                epub_cfi=f"aisu-scroll:{chapter_ratio:.4f}" if chapter_ratio is not None else None,
            ).touch()
        )
    session.commit()


def retire_reader_mark_positions(*, session, book_id: str, valid_keys: set[str] | None = None, reader_type: str | None = None) -> None:
    # Only invalidate coordinates, in the same transaction as publication.
    # Text, labels, IDs and dates survive; a recovered worker must not retire
    # notes created or relocated after the new edition was already published.
    statement = update(ReaderMarkRecord).where(ReaderMarkRecord.book_id == book_id, ReaderMarkRecord.position_valid.is_(True))
    if valid_keys is not None:
        statement = statement.where(or_(ReaderMarkRecord.position_key.is_(None), ReaderMarkRecord.position_key.not_in(valid_keys), ReaderMarkRecord.reader_type != reader_type))
    session.execute(statement.values(position_valid=False).execution_options(synchronize_session=False))


def resolve_replacement_chapter_position(
    *,
    asset_repository: BookAssetRepository,
    book_id: str,
    progress_percent: int,
    reader_type: str,
) -> tuple[int | None, float | None]:
    if reader_type not in {"epub", "text"}:
        return None, None

    chapters = filter_readable_text_assets(asset_repository.list_by_book(book_id, "text_chapter"))
    if not chapters:
        return None, None

    return resolve_progress_chapter_position(progress_percent, [get_reader_progress_weight(chapter) for chapter in chapters])
