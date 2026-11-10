from dataclasses import dataclass, field

from app.modules.book_assets.domain import BookAsset
from app.modules.books.domain import BookLanguage


@dataclass(frozen=True)
class ProcessingResult:
    assets: list[BookAsset] = field(default_factory=list)
    author: str | None = None
    cover_path: str | None = None
    current_chapter: str | None = None
    description: str | None = None
    page_count: int | None = None
    reader_type: str | None = None
    title: str | None = None
    language: BookLanguage | None = None
