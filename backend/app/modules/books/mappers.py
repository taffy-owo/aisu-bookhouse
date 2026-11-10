from typing import cast

from app.modules.books.domain import Book, BookKind, BookLanguage, BookLanguageMode, BookPublicationStatus, BookPublicStatus, BookStatus, ReaderType
from app.modules.books.models import BookRecord


def book_to_record(book: Book) -> BookRecord:
    return BookRecord(
        id=book.id,
        owner_id=book.owner_id,
        title=book.title,
        subtitle=book.subtitle,
        author=book.author,
        kind=book.kind,
        reader_type=book.reader_type,
        language=book.language,
        language_mode=book.language_mode,
        tags=list(book.tags),
        description=book.description,
        series_title=book.series_title,
        series_order=book.series_order,
        series_kind=book.series_kind,
        status=book.status,
        publication_status=book.publication_status,
        public_status=book.public_status,
        progress_percent=book.progress_percent,
        current_chapter=book.current_chapter,
        rating=book.rating,
        readers_label=book.readers_label,
        favorite=book.favorite,
        disliked=book.disliked,
        created_at=book.created_at,
        updated_at=book.updated_at,
        deleted_at=book.deleted_at,
        public_requested_at=book.public_requested_at,
        public_approved_at=book.public_approved_at,
        public_rejected_at=book.public_rejected_at,
        public_moderated_by=book.public_moderated_by,
        public_share_note=book.public_share_note,
        public_source_note=book.public_source_note,
        source_url=book.source_url,
        source_episode_count=book.source_episode_count,
        source_character_count=book.source_character_count,
        source_update_count=book.source_update_count,
        source_pending_episode_indexes=list(book.source_pending_episode_indexes),
        source_checked_at=book.source_checked_at,
        source_check_error=book.source_check_error,
        source_schedule_time=book.source_schedule_time,
        source_schedule_timezone=book.source_schedule_timezone,
        source_schedule_label=book.source_schedule_label,
        auto_translate_updates=book.auto_translate_updates,
        public_download_allowed=book.public_download_allowed,
        cover_url=book.cover_url,
        hero_image_url=book.hero_image_url,
        original_file_path=book.original_file_path,
        file_ext=book.file_ext,
        file_size=book.file_size,
        mime_type=book.mime_type,
    )


def update_book_record(record: BookRecord, book: Book) -> None:
    record.owner_id = book.owner_id
    record.title = book.title
    record.subtitle = book.subtitle
    record.author = book.author
    record.kind = book.kind
    record.reader_type = book.reader_type
    record.language = book.language
    record.language_mode = book.language_mode
    record.tags = list(book.tags)
    record.description = book.description
    record.series_title = book.series_title
    record.series_order = book.series_order
    record.series_kind = book.series_kind
    record.status = book.status
    record.publication_status = book.publication_status
    record.public_status = book.public_status
    record.progress_percent = book.progress_percent
    record.current_chapter = book.current_chapter
    record.rating = book.rating
    record.readers_label = book.readers_label
    record.favorite = book.favorite
    record.disliked = book.disliked
    record.created_at = book.created_at
    record.updated_at = book.updated_at
    record.deleted_at = book.deleted_at
    record.public_requested_at = book.public_requested_at
    record.public_approved_at = book.public_approved_at
    record.public_rejected_at = book.public_rejected_at
    record.public_moderated_by = book.public_moderated_by
    record.public_share_note = book.public_share_note
    record.public_source_note = book.public_source_note
    record.source_url = book.source_url
    record.source_episode_count = book.source_episode_count
    record.source_character_count = book.source_character_count
    record.source_update_count = book.source_update_count
    record.source_pending_episode_indexes = list(book.source_pending_episode_indexes)
    record.source_checked_at = book.source_checked_at
    record.source_check_error = book.source_check_error
    record.source_schedule_time = book.source_schedule_time
    record.source_schedule_timezone = book.source_schedule_timezone
    record.source_schedule_label = book.source_schedule_label
    record.auto_translate_updates = book.auto_translate_updates
    record.public_download_allowed = book.public_download_allowed
    record.cover_url = book.cover_url
    record.hero_image_url = book.hero_image_url
    record.original_file_path = book.original_file_path
    record.file_ext = book.file_ext
    record.file_size = book.file_size
    record.mime_type = book.mime_type


def record_to_book(record: BookRecord) -> Book:
    return Book(
        id=record.id,
        owner_id=record.owner_id,
        title=record.title,
        subtitle=record.subtitle,
        author=record.author,
        kind=cast(BookKind, record.kind),
        reader_type=cast(ReaderType, record.reader_type),
        language=cast(BookLanguage, getattr(record, "language", None) or "und"),
        language_mode=cast(BookLanguageMode | None, getattr(record, "language_mode", None)),
        tags=tuple(record.tags or []),
        description=record.description,
        series_title=record.series_title,
        series_order=record.series_order,
        series_kind=record.series_kind,
        status=cast(BookStatus, record.status),
        publication_status=cast(BookPublicationStatus, getattr(record, "publication_status", None) or "completed"),
        public_status=cast(BookPublicStatus, record.public_status),
        progress_percent=record.progress_percent,
        current_chapter=record.current_chapter,
        rating=record.rating,
        readers_label=record.readers_label,
        favorite=record.favorite,
        disliked=bool(getattr(record, "disliked", False)),
        created_at=record.created_at,
        updated_at=record.updated_at,
        deleted_at=record.deleted_at,
        public_requested_at=record.public_requested_at,
        public_approved_at=record.public_approved_at,
        public_rejected_at=record.public_rejected_at,
        public_moderated_by=record.public_moderated_by,
        public_share_note=record.public_share_note,
        public_source_note=record.public_source_note,
        source_url=getattr(record, "source_url", None),
        source_episode_count=getattr(record, "source_episode_count", None),
        source_character_count=getattr(record, "source_character_count", None),
        source_update_count=int(getattr(record, "source_update_count", 0) or 0),
        source_pending_episode_indexes=tuple(
            int(value)
            for value in (getattr(record, "source_pending_episode_indexes", None) or [])
            if isinstance(value, int) and not isinstance(value, bool) and value > 0
        ),
        source_checked_at=getattr(record, "source_checked_at", None),
        source_check_error=getattr(record, "source_check_error", None),
        source_schedule_time=getattr(record, "source_schedule_time", None),
        source_schedule_timezone=getattr(record, "source_schedule_timezone", None),
        source_schedule_label=getattr(record, "source_schedule_label", None),
        auto_translate_updates=bool(getattr(record, "auto_translate_updates", False)),
        public_download_allowed=record.public_download_allowed,
        cover_url=record.cover_url,
        hero_image_url=record.hero_image_url,
        original_file_path=record.original_file_path,
        file_ext=record.file_ext,
        file_size=record.file_size,
        mime_type=record.mime_type,
    )
