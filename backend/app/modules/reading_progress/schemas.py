from datetime import datetime, timedelta, timezone
from typing import Annotated

from pydantic import AfterValidator, BaseModel, Field


def validate_client_time(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("updated_at must include a timezone")
    normalized = value.astimezone(timezone.utc)
    if normalized > datetime.now(timezone.utc) + timedelta(minutes=5):
        raise ValueError("updated_at is too far in the future")
    return normalized


ClientProgressTimestamp = Annotated[datetime, AfterValidator(validate_client_time)]


class ReadingProgressPublic(BaseModel):
    book_id: str
    reader_type: str
    progress_percent: int = Field(ge=0, le=100)
    chapter_index: int | None = Field(default=None, ge=1)
    page_number: int | None = Field(default=None, ge=1)
    image_index: int | None = Field(default=None, ge=1)
    chapter_href: str | None = None
    epub_cfi: str | None = None
    updated_at: datetime


class ReadingProgressUpdate(BaseModel):
    content_version: str | None = Field(default=None, min_length=1, max_length=128, description="当前章节的 ReaderChapter.content_version；提交期间正文已修订返回 409。旧客户端可省略，百分比手动更新不应携带章节版本。")
    position_key: str | None = Field(default=None, min_length=1, max_length=128, description="当前正文的位置标识：章节取 ReaderChapter.position_key，图片取 ReaderPage.position_key，PDF 取 ReaderResource.position_key。标识或坐标过期返回 409。图片/PDF 带页码时必须传入标识；百分比手动更新可省略。章节旧客户端省略时不能校验同格式文件替换。")
    reader_type: str
    progress_percent: int = Field(ge=0, le=100)
    chapter_index: int | None = Field(default=None, ge=1)
    page_number: int | None = Field(default=None, ge=1)
    image_index: int | None = Field(default=None, ge=1)
    chapter_href: str | None = None
    epub_cfi: str | None = None
    updated_at: ClientProgressTimestamp | None = None

