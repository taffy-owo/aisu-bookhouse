"""add book file fields

Revision ID: 20260520_0002
Revises: 20260520_0001
Create Date: 2026-05-20
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260520_0002"
down_revision: str | None = "20260520_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("books", sa.Column("original_file_path", sa.String(length=1000), nullable=True))
    op.add_column("books", sa.Column("file_ext", sa.String(length=32), nullable=True))
    op.add_column("books", sa.Column("file_size", sa.Integer(), nullable=True))
    op.add_column("books", sa.Column("mime_type", sa.String(length=120), nullable=True))


def downgrade() -> None:
    op.drop_column("books", "mime_type")
    op.drop_column("books", "file_size")
    op.drop_column("books", "file_ext")
    op.drop_column("books", "original_file_path")
