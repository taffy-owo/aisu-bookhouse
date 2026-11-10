"""add book assets

Revision ID: 20260520_0003
Revises: 20260520_0002
Create Date: 2026-05-20
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260520_0003"
down_revision: str | None = "20260520_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "book_assets",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("book_id", sa.String(length=36), nullable=False),
        sa.Column("asset_type", sa.String(length=40), nullable=False),
        sa.Column("path", sa.String(length=1000), nullable=False),
        sa.Column("index", sa.Integer(), nullable=True),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["book_id"], ["books.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_book_assets_asset_type"), "book_assets", ["asset_type"], unique=False)
    op.create_index(op.f("ix_book_assets_book_id"), "book_assets", ["book_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_book_assets_book_id"), table_name="book_assets")
    op.drop_index(op.f("ix_book_assets_asset_type"), table_name="book_assets")
    op.drop_table("book_assets")
