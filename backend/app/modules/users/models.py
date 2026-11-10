from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class UserRecord(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    account_number: Mapped[int] = mapped_column(Integer, unique=True, index=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    nickname: Mapped[str] = mapped_column(String(120), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="user")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active")
    avatar: Mapped[str | None] = mapped_column(String(500), nullable=True)
    ai_provider_base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    ai_provider_api_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_translation_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    ai_translation_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_translation_concurrency: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    audiobook_provider_base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    audiobook_provider_api_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    audiobook_tts_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    audiobook_tts_voice: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
