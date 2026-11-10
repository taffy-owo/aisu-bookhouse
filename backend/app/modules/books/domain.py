from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Literal

BookKind = Literal["novel", "manga", "pdf", "image"]
BookStatus = Literal["uploading", "processing", "ready", "failed", "deleted"]
BookPublicStatus = Literal["private", "pending", "public", "rejected"]
BookPublicationStatus = Literal["ongoing", "completed"]
ReaderType = Literal["epub", "text", "pdf", "comic", "image", "unsupported"]
BookLanguage = Literal["und", "zh", "ja", "en", "other"]
BookLanguageMode = Literal["auto", "manual"]


@dataclass(frozen=True)
class Book:
    id: str
    owner_id: str
    title: str
    subtitle: str | None
    author: str
    kind: BookKind
    reader_type: ReaderType
    tags: tuple[str, ...]
    description: str
    status: BookStatus
    publication_status: BookPublicationStatus
    public_status: BookPublicStatus
    progress_percent: int
    current_chapter: str | None
    rating: float
    readers_label: str
    favorite: bool
    created_at: datetime
    updated_at: datetime
    disliked: bool = False
    deleted_at: datetime | None = None
    public_requested_at: datetime | None = None
    public_approved_at: datetime | None = None
    public_rejected_at: datetime | None = None
    public_moderated_by: str | None = None
    public_share_note: str | None = None
    public_source_note: str | None = None
    source_url: str | None = None
    public_download_allowed: bool = True
    cover_url: str | None = None
    hero_image_url: str | None = None
    original_file_path: str | None = None
    file_ext: str | None = None
    file_size: int | None = None
    mime_type: str | None = None
    series_title: str | None = None
    series_order: float | None = None
    series_kind: str | None = None
    language: BookLanguage = "und"
    language_mode: BookLanguageMode | None = "auto"
    source_episode_count: int | None = None
    source_character_count: int | None = None
    source_update_count: int = 0
    source_pending_episode_indexes: tuple[int, ...] = ()
    source_checked_at: datetime | None = None
    source_check_error: str | None = None
    source_schedule_time: str | None = None
    source_schedule_timezone: str | None = None
    source_schedule_label: str | None = None
    auto_translate_updates: bool = True
    # Preserve the persisted book revision when a response overlays viewer activity.
    version: datetime | None = None
    last_read_at: datetime | None = None

    @property
    def effective_language_mode(self) -> BookLanguageMode:
        # Older rows have no provenance. Preserve an existing known language;
        # unknown older books can still benefit from automatic recognition.
        if self.language_mode is None:
            return "auto" if self.language == "und" else "manual"
        return self.language_mode

    @property
    def has_reading_history(self) -> bool:
        return self.progress_percent > 0 or self.last_read_at is not None

    def resolve_processed_language(self, detected: BookLanguage | None) -> BookLanguage:
        return (detected or self.language) if self.effective_language_mode == "auto" else self.language

    def with_changes(self, **changes: object) -> "Book":
        if "updated_at" not in changes:
            changes["updated_at"] = datetime.now(timezone.utc)
        return replace(self, **changes)
