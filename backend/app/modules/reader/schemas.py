from typing import Literal

from pydantic import BaseModel, Field

from app.modules.books.schemas import BookPublic
from app.modules.reader_marks.schemas import ReaderMarkPublic
from app.modules.reading_progress.schemas import ReadingProgressPublic


class ReaderTocItem(BaseModel):
    content_version: str | None = None
    position_key: str | None = Field(default=None, description='章节的稳定位置标识，与对应 ReaderChapter.position_key 相同。')
    index: int
    title: str
    progress_weight: int | None = None
    level: int = 1
    section_title: str | None = None
    section_level: int = 1


class ReaderInlineSpan(BaseModel):
    text: str
    marks: list[Literal["strong", "emphasis", "emphasis_dot"]] = []
    ruby: str | None = None


class ReaderChapterBlock(BaseModel):
    type: Literal["image", "paragraph", "heading"]
    alt: str | None = None
    image_url: str | None = None
    image_width: int | None = None
    image_height: int | None = None
    text: str | None = None
    spans: list[ReaderInlineSpan] | None = None
    level: int | None = None


class ReaderChapter(BaseModel):
    content_version: str | None = None
    position_key: str | None = Field(default=None, description='保存阅读进度或备注时，将当前正文的标识作为 position_key 传回。')
    blocks: list[ReaderChapterBlock] = []
    content: str
    index: int
    title: str


class ReaderPage(BaseModel):
    position_key: str | None = Field(default=None, description='图片页的稳定标识；读取或保存位置时与当前页绑定，旧页不能用于新文件。')
    index: int
    image_url: str | None = None


class ReaderResource(BaseModel):
    position_key: str | None = Field(default=None, description='PDF 文件的稳定位置标识；更新访问票据或修改书名不会改变该标识。')
    reader_type: str
    version: str | None = None
    file_url: str | None = None
    cover_url: str | None = None
    toc: list[ReaderTocItem] = []
    chapter_count: int | None = None
    page_count: int | None = None
    pages: list[ReaderPage] = []


class ReaderStartup(BaseModel):
    book: BookPublic
    chapter: ReaderChapter | None = None
    marks: list[ReaderMarkPublic] = []
    progress: ReadingProgressPublic
    resource: ReaderResource


class ReaderAudiobookTicket(BaseModel):
    audio_url: str
    cached: bool
    chapter_index: int
    timeline_url: str


class ReaderAudiobookTimelineCue(BaseModel):
    end_seconds: float
    paragraph_index: int
    start_seconds: float


class ReaderAudiobookTimeline(BaseModel):
    cues: list[ReaderAudiobookTimelineCue]
    duration_seconds: float
    ready: bool
