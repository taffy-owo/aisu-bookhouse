from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class UploadTaskPublic(BaseModel):
    id: str
    book_id: str | None = None
    file_name: str
    file_type: str
    file_size: int
    status: str
    progress: int = Field(ge=0, le=100)
    message: str | None = None
    error_code: str | None = None
    created_at: datetime
    updated_at: datetime


class UploadBookResponse(BaseModel):
    book_id: str | None
    task_id: str
    status: str


class WorkSourceLookupRequest(BaseModel):
    url: str = Field(min_length=1, max_length=1000)


class WorkSourceEpisode(BaseModel):
    index: int = Field(ge=1)
    title: str
    url: str
    section_title: str | None = None
    section_level: int = Field(default=1, ge=1, le=6)


class WorkSourceMetadata(BaseModel):
    author: str
    character_count: int = Field(ge=0)
    cover_url: str | None = None
    description: str = ""
    episode_count: int = Field(ge=0)
    publication_status: Literal["ongoing", "completed"]
    source: Literal["hameln", "kakuyomu", "narou", "pixiv"]
    source_url: str
    tags: list[str]
    title: str
    episodes: list[WorkSourceEpisode] = Field(default_factory=list)
    schedule_label: str | None = None
    schedule_time: str | None = None
    schedule_timezone: str | None = None
    original_title: str | None = None
    translation_status: Literal["not_needed", "translated", "unavailable"] = "not_needed"
    translation_error_code: str | None = None
    translation_error_message: str | None = None
    translation_channel: str | None = None
    translation_model: str | None = None

