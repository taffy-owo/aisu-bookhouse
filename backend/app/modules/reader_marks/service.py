from datetime import datetime, timezone
from math import floor
from uuid import uuid4

from app.modules.book_assets.domain import BookAsset
from app.modules.book_assets.repository import BookAssetRepository
from app.modules.books.domain import Book
from app.modules.books.repository import BookRepository
from app.modules.reader.service import filter_readable_text_assets, get_reader_chapter_version
from app.modules.reader.page_identity import pdf_position_key
from app.modules.reading_progress.chapter_calculation import chapter_progress_percent, scroll_ratio
from app.modules.reader.position_validation import require_current_reader_position
from app.modules.reader_marks.domain import ReaderMark
from app.modules.reader_marks.repository import ReaderMarkRepository
from app.modules.reader_marks.schemas import ReaderMarkCreate, ReaderMarkPublic, ReaderMarkRelocate, ReaderMarkUpdate


def list_reader_marks_for_book(
    *,
    book_id: str,
    book_repository: BookRepository,
    mark_repository: ReaderMarkRepository,
    user_id: str,
    asset_repository: BookAssetRepository | None = None,
) -> list[ReaderMarkPublic] | None:
    book = book_repository.get_accessible(user_id, book_id)
    if not book:
        return None

    marks = mark_repository.list_for_book(user_id, book_id)
    positions = current_reader_assets(book, asset_repository) if any(
        mark.position_valid and mark.reader_type == book.reader_type
        for mark in marks) else None
    return [to_public(mark, positions if mark.reader_type == book.reader_type else None, book=book)
            for mark in marks]


def create_reader_mark_for_book(
    *,
    book_id: str,
    book_repository: BookRepository,
    mark_repository: ReaderMarkRepository,
    payload: ReaderMarkCreate,
    user_id: str,
    asset_repository: BookAssetRepository | None = None,
) -> ReaderMarkPublic | None:
    book = book_repository.get_accessible(user_id, book_id)
    if not book:
        return None

    if payload.position_key is None:
        book_repository.lock_revision(book)

    require_current_reader_position(book=book, book_repository=book_repository, asset_repository=asset_repository,
                                     chapter_index=payload.chapter_index, position_key=payload.position_key, reader_type=payload.reader_type,
                                     image_index=payload.image_index, page_number=payload.page_number, content_version=payload.content_version)
    now = datetime.now(timezone.utc)
    saved_mark = mark_repository.save(
        ReaderMark(
            id=str(uuid4()),
            user_id=user_id,
            book_id=book_id,
            reader_type=book.reader_type,
            kind=payload.kind,
            note=payload.note.strip(),
            label=payload.label.strip(),
            chapter_index=payload.chapter_index,
            image_index=payload.image_index,
            page_number=payload.page_number,
            epub_cfi=payload.epub_cfi,
            progress_percent=payload.progress_percent,
            position_key=payload.position_key,
            created_at=now,
            updated_at=now,
        )
    )
    return to_public(saved_mark, current_reader_assets(book, asset_repository), book=book)


def update_reader_mark(
    *,
    book_id: str,
    mark_id: str,
    mark_repository: ReaderMarkRepository,
    book_repository: BookRepository,
    payload: ReaderMarkUpdate,
    user_id: str,
    asset_repository: BookAssetRepository | None = None,
) -> ReaderMarkPublic | None:
    mark = lock_owned_mark(book_id=book_id, mark_id=mark_id, user_id=user_id, mark_repository=mark_repository, book_repository=book_repository)
    if not mark or mark.book_id != book_id:
        return None

    note = payload.note.strip() if payload.note is not None else mark.note
    label = (payload.label or mark.label).strip()
    saved_mark = mark_repository.save(mark.with_changes(note=note, label=label))
    book = book_repository.get_by_id(book_id)
    positions = current_reader_assets(book, asset_repository) if book and book.reader_type == mark.reader_type else None
    return to_public(saved_mark, positions, book=book)


def delete_reader_mark(*, book_id: str, mark_id: str, mark_repository: ReaderMarkRepository, book_repository: BookRepository, user_id: str) -> bool:
    mark = lock_owned_mark(book_id=book_id, mark_id=mark_id, user_id=user_id, mark_repository=mark_repository, book_repository=book_repository)
    if not mark or mark.book_id != book_id:
        return False

    return mark_repository.delete(user_id, mark_id)


def lock_owned_mark(*, book_id: str, mark_id: str, user_id: str, mark_repository: ReaderMarkRepository, book_repository: BookRepository) -> ReaderMark | None:
    mark = mark_repository.get(user_id, mark_id)
    if not mark or mark.book_id != book_id:
        return None
    # The note belongs to its reader even after a shared book becomes private.
    # Serialize content edits/deletion with publication without restoring a
    # stale coordinate snapshot over a newly invalidated or relocated mark.
    book = book_repository.get_by_id(book_id)
    if not book or book.status == "deleted":
        return None
    book_repository.lock_revision(book)
    return mark_repository.get(user_id, mark_id)


def relocate_reader_mark_for_book(*, book_id: str, mark_id: str, user_id: str, payload: ReaderMarkRelocate,
                                  book_repository: BookRepository, asset_repository: BookAssetRepository,
                                  mark_repository: ReaderMarkRepository) -> ReaderMarkPublic | None:
    book = book_repository.get_accessible(user_id, book_id)
    if not book:
        return None
    require_current_reader_position(book=book, book_repository=book_repository, asset_repository=asset_repository,
                                    position_key=payload.position_key, reader_type=payload.reader_type,
                                    chapter_index=payload.chapter_index, image_index=payload.image_index, page_number=payload.page_number, content_version=payload.content_version)
    mark = mark_repository.get(user_id, mark_id)
    if not mark or mark.book_id != book_id:
        return None
    saved = mark_repository.save(mark.with_changes(
        reader_type=book.reader_type, position_key=payload.position_key, position_valid=True,
        chapter_index=payload.chapter_index, image_index=payload.image_index, page_number=payload.page_number,
        epub_cfi=payload.epub_cfi, progress_percent=payload.progress_percent,
    ))
    return to_public(saved, current_reader_assets(book, asset_repository), book=book)


def current_reader_assets(book: Book, asset_repository: BookAssetRepository | None) -> list[BookAsset] | None:
    if asset_repository is None:
        return None
    if book.reader_type in {"epub", "text"}:
        return filter_readable_text_assets(asset_repository.list_by_book(book.id, "text_chapter"))
    if book.reader_type in {"comic", "image"}:
        return asset_repository.list_by_book(book.id, "comic_page" if book.reader_type == "comic" else "image_page")
    return None


def to_public(mark: ReaderMark, positions: list[BookAsset] | None = None, *, book: Book | None = None) -> ReaderMarkPublic:
    content_version = None
    percent = mark.progress_percent
    index = mark.chapter_index
    image_index = mark.image_index
    page_number = mark.page_number
    valid = mark.position_valid and (book is None or mark.reader_type == book.reader_type)
    ratio = scroll_ratio(mark.epub_cfi)
    # Availability and percentage describe the current file, not a note edit.
    # Stable identities can move; missing identities must never jump into the
    # unrelated text/page that now happens to occupy the old ordinal.
    if valid and positions is not None:
        if mark.reader_type in {"epub", "text"} and (positions or mark.position_key):
            resolved = next((i for i, item in enumerate(positions, 1) if item.id == mark.position_key), None) if mark.position_key else index
            valid = bool(resolved is not None and 1 <= resolved <= len(positions)
                         and image_index is None and page_number is None)
            if valid:
                index = resolved
                content_version = get_reader_chapter_version(positions[index - 1])
                if ratio is not None:
                    percent = chapter_progress_percent(positions, index, ratio)
        elif mark.reader_type in {"comic", "image"}:
            resolved = next((i for i, item in enumerate(positions, 1) if item.id == mark.position_key), None) if mark.position_key else image_index or page_number
            valid = bool(resolved is not None and 1 <= resolved <= len(positions) and index is None
                         and (image_index is None or page_number is None or image_index == page_number))
            if valid:
                image_index = resolved
                if page_number is not None:
                    page_number = resolved
                percent = 100 if resolved == len(positions) else min(99, max(1, floor(resolved / len(positions) * 100 + .5)))
    if valid and book and mark.reader_type == "pdf":
        key = pdf_position_key(book)
        valid = bool(key and page_number is not None and page_number >= 1 and index is None and image_index is None
                     and (not mark.position_key or mark.position_key == key))
    return ReaderMarkPublic(
        content_version=content_version,
        id=mark.id,
        book_id=mark.book_id,
        reader_type=mark.reader_type,
        kind=mark.kind,
        note=mark.note,
        label=mark.label,
        position_key=mark.position_key,
        position_valid=valid,
        chapter_index=index,
        image_index=image_index,
        page_number=page_number,
        epub_cfi=mark.epub_cfi,
        progress_percent=percent,
        created_at=mark.created_at,
        updated_at=mark.updated_at,
    )
