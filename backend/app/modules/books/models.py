from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class BookTranslationContextRecord(Base):
    __tablename__ = "book_translation_contexts"

    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    context_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)


class BookRecord(Base):
    __tablename__ = "books"
    __table_args__ = (
        Index("ix_books_owner_created_id", "owner_id", "created_at", "id"),
        Index("ix_books_owner_favorite_updated", "owner_id", "favorite", "updated_at"),
        Index("ix_books_public_status_updated_id", "public_status", "status", "updated_at", "id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    subtitle: Mapped[str | None] = mapped_column(String(255), nullable=True)
    author: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    reader_type: Mapped[str] = mapped_column(String(32), nullable=False)
    language: Mapped[str] = mapped_column(String(16), index=True, nullable=False, default="und")
    language_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    series_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    series_order: Mapped[float | None] = mapped_column(Float, nullable=True)
    series_kind: Mapped[str | None] = mapped_column(String(80), nullable=True)
    status: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    publication_status: Mapped[str] = mapped_column(String(32), nullable=False, default="completed")
    public_status: Mapped[str] = mapped_column(String(32), index=True, nullable=False, default="private")
    progress_percent: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    current_chapter: Mapped[str | None] = mapped_column(String(255), nullable=True)
    rating: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    readers_label: Mapped[str] = mapped_column(String(80), nullable=False, default="仅自己")
    favorite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    disliked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    public_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    public_approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    public_rejected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    public_moderated_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    public_share_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    public_source_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    source_episode_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_character_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_update_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_pending_episode_indexes: Mapped[list[int]] = mapped_column(JSON, nullable=False, default=list)
    source_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    source_check_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    source_schedule_time: Mapped[str | None] = mapped_column(String(5), nullable=True)
    source_schedule_timezone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_schedule_label: Mapped[str | None] = mapped_column(String(120), nullable=True)
    auto_translate_updates: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    public_download_allowed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    cover_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    hero_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    original_file_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    file_ext: Mapped[str | None] = mapped_column(String(32), nullable=True)
    file_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mime_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
