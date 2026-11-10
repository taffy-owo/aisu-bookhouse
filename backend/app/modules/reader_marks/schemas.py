from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ReaderMarkPublic(BaseModel):
    content_version: str | None = Field(default=None, description="有效定位在本次读取时核对的正文版本；目录版本变化时，客户端应先禁用旧响应中的定位。")
    id: str
    book_id: str
    reader_type: str
    kind: str
    note: str
    label: str
    position_key: str | None = Field(default=None, description="标记保存时的正文标识；旧记录可能没有此值。")
    position_valid: bool = Field(default=True, description="定位是否适用于当前文件和目录；旧格式、缺失正文或越界坐标返回 false，保留内容并允许明确重新定位。读取不会改写笔记或时间。")
    chapter_index: int | None = None
    image_index: int | None = None
    page_number: int | None = None
    epub_cfi: str | None = None
    progress_percent: int = Field(ge=0, le=100)
    created_at: datetime
    updated_at: datetime


class ReaderMarkCreate(BaseModel):
    content_version: str | None = Field(default=None, min_length=1, max_length=128, description="章节的 ReaderChapter.content_version；提交期间正文已修订返回 409，旧客户端可省略。")
    position_key: str | None = Field(default=None, min_length=1, max_length=128, description="当前正文的位置标识：章节取 ReaderChapter.position_key，图片取 ReaderPage.position_key，PDF 取 ReaderResource.position_key。标识或坐标过期返回 409。图片/PDF 带页码时必须传入标识；百分比手动更新可省略。章节旧客户端省略时不能校验同格式文件替换。")
    reader_type: str
    kind: Literal["bookmark", "note"] = "bookmark"
    note: str = Field(default="", max_length=2000)
    label: str = Field(default="", max_length=255)
    chapter_index: int | None = Field(default=None, ge=1)
    image_index: int | None = Field(default=None, ge=1)
    page_number: int | None = Field(default=None, ge=1)
    epub_cfi: str | None = Field(default=None, max_length=1000)
    progress_percent: int = Field(ge=0, le=100)


class ReaderMarkUpdate(BaseModel):
    note: str | None = Field(default=None, max_length=2000)
    label: str | None = Field(default=None, max_length=255)


class ReaderMarkRelocate(BaseModel):
    content_version: str | None = Field(default=None, min_length=1, max_length=128, description="重新定位目标章节的 ReaderChapter.content_version；过期返回 409，保留原备注。")
    position_key: str = Field(min_length=1, max_length=128, description="当前正文的位置标识，来自 ReaderChapter、ReaderPage 或 ReaderResource；过期返回 409。")
    reader_type: str
    chapter_index: int | None = Field(default=None, ge=1)
    image_index: int | None = Field(default=None, ge=1)
    page_number: int | None = Field(default=None, ge=1)
    epub_cfi: str | None = Field(default=None, max_length=1000)
    progress_percent: int = Field(ge=0, le=100)
