from datetime import timezone

from app.modules.book_assets.repository import BookAssetRepository
from app.modules.reader.position_validation import require_current_reader_position
from app.modules.reader.service import filter_readable_text_assets
from app.modules.reading_progress.chapter_calculation import chapter_progress_percent, scroll_ratio
from app.modules.books.domain import Book
from app.modules.books.repository import BookRepository
from app.modules.reading_progress.domain import ReadingProgress
from app.modules.reading_progress.repository import ReadingProgressRepository
from app.modules.reading_progress.schemas import ReadingProgressPublic, ReadingProgressUpdate


def get_progress_for_book(
    user_id: str,
    book_id: str,
    book_repository: BookRepository,
    progress_repository: ReadingProgressRepository,
) -> ReadingProgressPublic | None:
    book = book_repository.get_accessible(user_id, book_id)
    if not book:
        return None

    initial_position_time = book.created_at
    if initial_position_time.tzinfo is None or initial_position_time.utcoffset() is None:
        initial_position_time = initial_position_time.replace(tzinfo=timezone.utc)

    saved_progress = progress_repository.get(user_id, book_id)
    if saved_progress and saved_progress.reader_type != book.reader_type:
        # Positions from another format have no meaning in this file. Keep the
        # stored history intact until the reader saves a position in the new one.
        return to_public(ReadingProgress(
            user_id=user_id, book_id=book_id, reader_type=book.reader_type, progress_percent=0,
            chapter_index=1 if book.reader_type in {"text", "epub"} else None,
            image_index=1 if book.reader_type in {"comic", "image"} else None,
            page_number=1 if book.reader_type == "pdf" else None,
            updated_at=initial_position_time,
        ))
    if saved_progress:
        return to_public(saved_progress)

    return to_public(
        ReadingProgress(
            user_id=user_id,
            book_id=book.id,
            reader_type=book.reader_type,
            progress_percent=book.progress_percent if book.owner_id == user_id else 0,
            chapter_index=1 if book.reader_type in ("text", "epub") else None,
            image_index=1 if book.reader_type in ("comic", "image") else None,
            page_number=1 if book.reader_type == "pdf" else None,
            # A synthesized starting position is not a new reading event.
            # Its stable time must not outrank a newer unsent client position.
            updated_at=initial_position_time,
        )
    )


def save_progress_for_book(
    user_id: str,
    book_id: str,
    payload: ReadingProgressUpdate,
    book_repository: BookRepository,
    progress_repository: ReadingProgressRepository,
    asset_repository: BookAssetRepository | None = None,
) -> ReadingProgressPublic | None:
    book = book_repository.get_accessible(user_id, book_id)
    if not book:
        return None

    require_current_reader_position(book=book, book_repository=book_repository, asset_repository=asset_repository,
                                     chapter_index=payload.chapter_index, position_key=payload.position_key, reader_type=payload.reader_type,
                                     image_index=payload.image_index, page_number=payload.page_number, content_version=payload.content_version)
    percent = payload.progress_percent
    ratio = scroll_ratio(payload.epub_cfi)
    if (asset_repository is not None and book.reader_type in {"text", "epub"}
            and payload.chapter_index is not None
            and (ratio is not None or payload.progress_percent >= 100)):
        # An already-open reader can use the old catalog's denominator, even
        # when a legacy client omits stable keys. Validated chapter coordinates
        # use current weights; percentage-only manual changes remain explicit.
        chapters = filter_readable_text_assets(asset_repository.list_by_book(book_id, "text_chapter"))
        if chapters:
            # A few older API clients sent the chapter coordinate but omitted
            # the scroll marker. Their stale 100% was the end of the old
            # catalogue, not proof that the expanded catalogue was finished.
            # Treat that coordinate as the end of the reported chapter so it
            # can never mark the whole book complete before its last chapter.
            percent = chapter_progress_percent(
                chapters, payload.chapter_index, ratio if ratio is not None else (1.0 if payload.progress_percent >= 100 else 0.0)
            )
    saved_progress = progress_repository.save(
        ReadingProgress(
            user_id=user_id,
            book_id=book_id,
            # The book is authoritative. A stale client can report the old
            # reader type after reprocessing or switching devices; persisting
            # that value would make later readers interpret the position with
            # the wrong coordinate system.
            reader_type=book.reader_type,
            progress_percent=percent,
            chapter_index=payload.chapter_index,
            page_number=payload.page_number,
            image_index=payload.image_index,
            chapter_href=payload.chapter_href,
            epub_cfi=payload.epub_cfi,
            updated_at=payload.updated_at,
        )
    )
    return to_public(saved_progress)


def overlay_progress(book: Book, progress: ReadingProgress | None) -> Book:
    if not progress:
        return book
    if progress.reader_type != book.reader_type:
        return book.with_changes(progress_percent=0, current_chapter=None, updated_at=book.updated_at, last_read_at=None)

    current_chapter = book.current_chapter if progress.has_reading_history else None
    if progress.image_index is not None:
        current_chapter = f"第 {progress.image_index} 页"
    elif progress.page_number is not None:
        current_chapter = f"第 {progress.page_number} 页"
    elif progress.chapter_index is not None:
        current_chapter = f"第 {progress.chapter_index} 章"

    return book.with_changes(progress_percent=progress.progress_percent, current_chapter=current_chapter,
                             version=book.version or book.updated_at, updated_at=progress.updated_at,
                             last_read_at=progress.updated_at if progress.has_reading_history else None)


def to_public(progress: ReadingProgress) -> ReadingProgressPublic:
    if progress.updated_at is None:
        progress = progress.touch()

    return ReadingProgressPublic(
        book_id=progress.book_id,
        reader_type=progress.reader_type,
        progress_percent=progress.progress_percent,
        chapter_index=progress.chapter_index,
        page_number=progress.page_number,
        image_index=progress.image_index,
        chapter_href=progress.chapter_href,
        epub_cfi=progress.epub_cfi,
        updated_at=progress.updated_at,
    )
