from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, false, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AiChannelRecord(Base):
    """One provider endpoint: a base URL plus the credential that opens it.

    A user may keep several. Translation jobs reference the model rows below
    rather than this table directly, so a channel can be re-pointed or
    re-credentialed without touching in-flight work.
    """

    __tablename__ = "ai_channels"
    __table_args__ = (Index("uq_ai_channels_provider_default", "user_id", unique=True,
        sqlite_where=text("is_provider_default = 1"), postgresql_where=text("is_provider_default")),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    api_key_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_provider_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=false())
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AiChannelModelRecord(Base):
    """A single model on a channel, with the tuning that model needs.

    Concurrency and chunk sizes used to be hardcoded per model name in both the
    backend and the UI, so adding a model meant a code change and a deploy.
    """

    __tablename__ = "ai_channel_models"
    __table_args__ = (UniqueConstraint("channel_id", "model", name="uq_ai_channel_models_channel_model"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    channel_id: Mapped[str] = mapped_column(ForeignKey("ai_channels.id"), index=True, nullable=False)
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_concurrency: Mapped[int] = mapped_column(Integer, nullable=False, default=4)
    chunk_characters: Mapped[int] = mapped_column(Integer, nullable=False, default=4500)
    chunk_paragraphs: Mapped[int] = mapped_column(Integer, nullable=False, default=220)
    # Set when the channel reports the model is out of quota or otherwise
    # unusable. New jobs skip it and the UI greys it out until the time passes.
    unavailable_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    unavailable_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
    availability_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
