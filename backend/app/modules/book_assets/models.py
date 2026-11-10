from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class BookAssetRecord(Base):
    __tablename__ = "book_assets"
    __table_args__ = (
        # Reader hot path: get_by_index / list_by_book filter on
        # (book_id, asset_type) and order by index. One composite index serves
        # the filter + ordering and replaces the standalone book_id / asset_type
        # indexes (4.5k+ rows; comic page-turns hit this constantly).
        Index("ix_book_assets_book_asset_index", "book_id", "asset_type", "index"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id"), nullable=False)
    asset_type: Mapped[str] = mapped_column(String(40), nullable=False)
    path: Mapped[str] = mapped_column(String(1000), nullable=False)
    index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    metadata_json: Mapped[dict[str, object]] = mapped_column("metadata", JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
