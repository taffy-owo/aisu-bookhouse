from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class WholeBookTranslationJobRecord(Base):
    __tablename__ = "whole_book_translation_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    book_id: Mapped[str | None] = mapped_column(ForeignKey("books.id"), index=True, nullable=True)
    job_kind: Mapped[str] = mapped_column(String(32), nullable=False, default="whole_book")
    source_url: Mapped[str] = mapped_column(String(1000), index=True, nullable=False)
    source_provider: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    author: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    stage: Mapped[str] = mapped_column(String(32), nullable=False)
    progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_chapters: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completed_chapters: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    current_chapter_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    model: Mapped[str] = mapped_column(String(160), nullable=False)
    channel_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    custom_instructions: Mapped[str | None] = mapped_column(Text, nullable=True)
    request_concurrency: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    pause_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Consecutive transient provider failures. Drives an escalating backoff so a
    # brief blip retries in seconds while an exhausted daily quota parks the job
    # instead of re-failing every 30 seconds for hours.
    provider_failure_streak: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    quota_resume_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    catalog_translation_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    provider_base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    provider_api_key_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_json: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False, default=dict)
    translated_metadata_json: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False, default=dict)
    catalog_json: Mapped[list[dict[str, object]]] = mapped_column(JSON, nullable=False, default=list)
    memory_json: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False, default=dict)
    quality_report_json: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False, default=dict)
    acknowledged: Mapped[bool] = mapped_column(Boolean, index=True, nullable=False, default=False)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lease_owner: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
