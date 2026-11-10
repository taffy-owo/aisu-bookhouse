"""add user-selected whole-book translation concurrency

Revision ID: 20260808_0028
Revises: 20260803_0027
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260808_0028"
down_revision: str | None = "20260803_0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    user_columns = {column["name"] for column in inspector.get_columns("users")}
    if "ai_translation_concurrency" not in user_columns:
        op.add_column(
            "users",
            sa.Column("ai_translation_concurrency", sa.Integer(), nullable=False, server_default="2"),
        )
    job_columns = {column["name"] for column in inspector.get_columns("whole_book_translation_jobs")}
    if "request_concurrency" not in job_columns:
        op.add_column(
            "whole_book_translation_jobs",
            sa.Column("request_concurrency", sa.Integer(), nullable=False, server_default="2"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    job_columns = {column["name"] for column in inspector.get_columns("whole_book_translation_jobs")}
    if "request_concurrency" in job_columns:
        op.drop_column("whole_book_translation_jobs", "request_concurrency")
    user_columns = {column["name"] for column in inspector.get_columns("users")}
    if "ai_translation_concurrency" in user_columns:
        op.drop_column("users", "ai_translation_concurrency")
