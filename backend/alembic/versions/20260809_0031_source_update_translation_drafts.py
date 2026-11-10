"""add source update translation draft settings

Revision ID: 20260809_0031
Revises: 20260808_0030
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260809_0031"
down_revision: str | None = "20260808_0030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    book_columns = {column["name"] for column in inspector.get_columns("books")}
    if "auto_translate_updates" not in book_columns:
        op.add_column("books", sa.Column("auto_translate_updates", sa.Boolean(), nullable=False, server_default=sa.false()))

    job_columns = {column["name"] for column in inspector.get_columns("whole_book_translation_jobs")}
    if "job_kind" not in job_columns:
        op.add_column(
            "whole_book_translation_jobs",
            sa.Column("job_kind", sa.String(length=32), nullable=False, server_default="whole_book"),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    job_columns = {column["name"] for column in inspector.get_columns("whole_book_translation_jobs")}
    if "job_kind" in job_columns:
        op.drop_column("whole_book_translation_jobs", "job_kind")
    book_columns = {column["name"] for column in inspector.get_columns("books")}
    if "auto_translate_updates" in book_columns:
        op.drop_column("books", "auto_translate_updates")
