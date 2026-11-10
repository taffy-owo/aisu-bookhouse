from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.modules.reading_progress.schemas import ClientProgressTimestamp, ReadingProgressPublic

BookKind = Literal["novel", "manga", "pdf", "image"]
BookPublicationStatus = Literal["ongoing", "completed"]
BookPublicStatus = Literal["private", "pending", "public", "rejected"]
BookSortKey = Literal["recent", "created", "title", "progress", "comments", "words", "chapters"]
ReaderType = Literal["epub", "text", "pdf", "comic", "image", "unsupported"]
BookLanguage = Literal["und", "zh", "ja", "en", "other"]


class BookPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    subtitle: str | None = None
    author: str
    kind: BookKind
    reader_type: ReaderType
    language: BookLanguage = "und"
    language_mode: Literal["auto", "manual"] = "auto"
    tags: list[str]
    progress_percent: int = Field(ge=0, le=100)
    current_chapter: str | None = None
    rating: float = 0
    readers_label: str = "仅自己"
    updated_at: datetime
    last_read_at: datetime | None = None
    version: datetime | None = Field(default=None, description="图书版本时间，与阅读器资源的 version 对应；不随阅读进度更新。")
    created_at: datetime
    description: str
    cover_url: str | None = None
    hero_image_url: str | None = None
    file_ext: str | None = None
    file_size: int | None = None
    mime_type: str | None = None
    publication_status: BookPublicationStatus = "completed"
    source_url: str | None = None
    source_episode_count: int | None = None
    source_character_count: int | None = None
    source_update_count: int = 0
    source_checked_at: datetime | None = None
    source_check_error: str | None = None
    source_schedule_time: str | None = None
    source_schedule_timezone: str | None = None
    source_schedule_label: str | None = None
    auto_translate_updates: bool = True
    series_title: str | None = None
    series_order: float | None = None
    series_kind: str | None = None
    favorite: bool = False
    disliked: bool = False
    status: str
    public_status: BookPublicStatus = "private"
    public_requested_at: datetime | None = None
    public_approved_at: datetime | None = None
    public_rejected_at: datetime | None = None
    public_share_note: str | None = None
    public_source_note: str | None = None
    public_download_allowed: bool = True
    owner_id: str
    owner_nickname: str | None = None
    comment_count: int = 0
    chapter_count: int = 0
    page_count: int = 0
    character_count: int = 0
    asset_count: int = 0
    last_content_updated_at: datetime | None = None
    is_owned: bool = True


class BookListResponse(BaseModel):
    items: list[BookPublic]
    total: int
    page: int = 1
    page_size: int = 24
    has_more: bool = False


class BookLabel(BaseModel):
    id: str
    title: str


class BookShelfOverview(BaseModel):
    items: list[BookPublic]
    book_labels: list[BookLabel]
    total: int
    favorite_count: int
    in_progress_count: int
    finished_count: int
    ongoing_count: int = 0
    source_update_count: int = 0
    updated_items: list[BookPublic] = Field(default_factory=list)
    continue_book: BookPublic | None = None


class SourceUpdateNotificationList(BaseModel):
    items: list[BookPublic]
    book_count: int
    episode_count: int


class BookChapterAppend(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    content: str = Field(min_length=1, max_length=1_000_000)
    content_is_body: bool = Field(default=False, description="The editor has already separated the title from the chapter body")


class BookChapterAppendResult(BaseModel):
    chapter_count: int
    index: int
    text_length: int
    title: str


class BookChapterDeleteResult(BaseModel):
    chapter_count: int
    deleted_index: int
    next_index: int | None = None


class BookEditableChapter(BaseModel):
    index: int
    title: str


class BookEditableChapterContent(BaseModel):
    content: str
    format: Literal["epub", "text"]
    has_images: bool = False
    revision: str = Field(description='编辑时读取的章节版本；修改或删除时通过 If-Match 原样提交')
    index: int
    title: str


class SourceCatalogSyncResult(BaseModel):
    catalog_count: int
    matched_count: int
    renamed_count: int


class BookUpdate(BaseModel):
    expected_updated_at: datetime | None = None
    # Length limits mirror the column definitions in books/models.py
    # (title/author are String(255); description is Text but capped to a sane size).
    title: str | None = Field(default=None, max_length=255)
    author: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=5000)
    tags: list[Annotated[str, Field(max_length=64)]] | None = Field(default=None, max_length=50)
    publication_status: BookPublicationStatus | None = None
    source_url: str | None = Field(default=None, max_length=1000)
    source_episode_count: int | None = Field(default=None, ge=0)
    source_character_count: int | None = Field(default=None, ge=0)
    source_schedule_time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    source_schedule_timezone: Literal["Asia/Tokyo"] | None = None
    source_schedule_label: str | None = Field(default=None, max_length=120)
    auto_translate_updates: bool | None = None
    series_title: str | None = Field(default=None, max_length=255)
    series_order: float | None = None
    series_kind: str | None = Field(default=None, max_length=80)
    rating: float | None = Field(default=None, ge=0, le=10)
    language: BookLanguage | Literal["auto"] | None = None


class BookReadingStatusUpdate(BaseModel):
    finished: bool
    updated_at: ClientProgressTimestamp | None = Field(default=None, description="本次操作的时间，须晚于尚未同步的本地阅读位置，防止延迟自动保存覆盖已读或未读状态。")


class BookReadingStatusResult(BookPublic):
    reading_progress: ReadingProgressPublic


class BookPublicShareRequest(BaseModel):
    public_download_allowed: bool = True
    share_note: str | None = Field(default=None, max_length=600)
    source_note: str | None = Field(default=None, max_length=300)

