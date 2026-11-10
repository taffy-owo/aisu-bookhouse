from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ReadingActivityRecord(Base):
    __tablename__ = "reading_activity"
    __table_args__ = (
        UniqueConstraint("user_id", "date_key", "book_id", name="uq_reading_activity_user_date_book"),
        Index("ix_reading_activity_user_book", "user_id", "book_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    book_id: Mapped[str | None] = mapped_column(ForeignKey("books.id"), index=True, nullable=True)
    # Snapshot the title at read time. Books are soft-deleted today, but the
    # activity history must remain meaningful even after a later hard purge or
    # when the replacement edition has a different title.
    book_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    date_key: Mapped[str] = mapped_column(String(10), index=True, nullable=False)
    seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ReadingActivityEventRecord(Base):
    """Idempotency ledger for browser activity outbox events.

    The browser keeps failed events locally and retries them. Persisting the
    event id in the same transaction as the aggregate update prevents a retry
    after an uncertain network response from counting the same seconds twice.
    """

    __tablename__ = "reading_activity_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
