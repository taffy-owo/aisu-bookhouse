from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone


@dataclass(frozen=True)
class ReadingProgress:
    user_id: str
    book_id: str
    reader_type: str
    progress_percent: int
    chapter_index: int | None = None
    page_number: int | None = None
    image_index: int | None = None
    chapter_href: str | None = None
    epub_cfi: str | None = None
    updated_at: datetime | None = None

    @property
    def has_reading_history(self) -> bool:
        return self.progress_percent > 0 or any((
            self.chapter_index is not None, self.page_number is not None,
            self.image_index is not None, self.chapter_href, self.epub_cfi,
        ))

    def touch(self) -> "ReadingProgress":
        updated_at = datetime.now(timezone.utc)
        if self.updated_at is not None:
            previous = self.updated_at if self.updated_at.tzinfo else self.updated_at.replace(tzinfo=timezone.utc)
            # Server-side structural changes must supersede an accepted client
            # timestamp even when that device's clock is slightly ahead.
            updated_at = max(updated_at, previous + timedelta(microseconds=1))
        return replace(self, updated_at=updated_at)

