from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone

ReaderMarkKind = str


@dataclass(frozen=True)
class ReaderMark:
    id: str
    user_id: str
    book_id: str
    reader_type: str
    kind: ReaderMarkKind
    note: str
    label: str
    progress_percent: int
    position_key: str | None = None
    position_valid: bool = True
    chapter_index: int | None = None
    image_index: int | None = None
    page_number: int | None = None
    epub_cfi: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    def with_changes(self, **changes: object) -> "ReaderMark":
        updated_at = datetime.now(timezone.utc)
        if self.updated_at is not None:
            previous = self.updated_at if self.updated_at.tzinfo else self.updated_at.replace(tzinfo=timezone.utc)
            updated_at = max(updated_at, previous + timedelta(microseconds=1))
        return replace(self, updated_at=updated_at, **changes)
