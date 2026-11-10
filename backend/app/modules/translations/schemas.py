from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


TranslationJobStatus = Literal[
    "queued", "processing", "paused", "waiting_quota", "review", "ready", "rejected", "failed"
]


class CreateWholeBookTranslationRequest(BaseModel):
    source_url: str = Field(min_length=1, max_length=1000)
    custom_instructions: str | None = Field(default=None, max_length=6000)
    model: str = Field(min_length=1, max_length=128)
    channel_id: str | None = Field(default=None, max_length=36)
    request_concurrency: int | None = Field(default=None, ge=1, le=16)


class WholeBookTranslationJobPublic(BaseModel):
    id: str
    book_id: str | None = None
    job_kind: Literal["whole_book", "source_update"] = "whole_book"
    source_url: str
    source_provider: str
    title: str
    author: str
    status: TranslationJobStatus
    stage: str
    progress: int = Field(ge=0, le=100)
    total_chapters: int = Field(ge=0)
    completed_chapters: int = Field(ge=0)
    current_chapter_index: int | None = None
    message: str | None = None
    error_message: str | None = None
    model: str
    channel_id: str | None = None
    channel_name: str = ""
    request_concurrency: int = Field(ge=1, le=16)
    max_concurrency: int = Field(default=4, ge=1, le=16)
    quality_status: Literal["pending", "passed", "warning"] = "pending"
    quality_issue_count: int = Field(default=0, ge=0)
    pause_requested: bool = False
    quota_resume_at: datetime | None = None
    acknowledged: bool
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None = None


class WholeBookTranslationNotificationList(BaseModel):
    unread_count: int
    active_count: int
    items: list[WholeBookTranslationJobPublic]


class SourceUpdateTranslationDraftChapter(BaseModel):
    index: int
    title: str
    source_title: str
    source_url: str
    content: str


class SourceUpdateTranslationDraftReview(BaseModel):
    book_id: str
    chapters: list[SourceUpdateTranslationDraftChapter]
    job_id: str
    status: TranslationJobStatus
    title: str


class UpdateTranslationConcurrencyRequest(BaseModel):
    request_concurrency: int = Field(ge=1, le=16)


class UpdateTranslationModelRequest(BaseModel):
    """Re-point a job that is not currently running at a different lane."""

    model: str = Field(min_length=1, max_length=128)
    channel_id: str | None = Field(default=None, max_length=36)
