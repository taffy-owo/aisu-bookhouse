from dataclasses import dataclass
from datetime import datetime
from typing import Literal

AssetType = Literal["chapter_image", "cover", "comic_page", "image_page", "text_chapter"]


@dataclass(frozen=True)
class BookAsset:
    id: str
    book_id: str
    asset_type: AssetType
    path: str
    index: int | None
    metadata: dict[str, object]
    created_at: datetime


@dataclass(frozen=True)
class BookAssetStats:
    book_id: str
    asset_count: int = 0
    chapter_count: int = 0
    page_count: int = 0
    character_count: int = 0
    last_content_updated_at: datetime | None = None
