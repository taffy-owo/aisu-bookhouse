"""add account and per-job translation preferences

Revision ID: 20260803_0027
Revises: 20260802_0026
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260803_0027"
down_revision: str | None = "20260802_0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    user_columns = {column["name"] for column in inspector.get_columns("users")}
    if "ai_translation_prompt" not in user_columns:
        op.add_column("users", sa.Column("ai_translation_prompt", sa.Text(), nullable=True))
    job_columns = {column["name"] for column in inspector.get_columns("whole_book_translation_jobs")}
    if "custom_instructions" not in job_columns:
        op.add_column("whole_book_translation_jobs", sa.Column("custom_instructions", sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    job_columns = {column["name"] for column in inspector.get_columns("whole_book_translation_jobs")}
    if "custom_instructions" in job_columns:
        op.drop_column("whole_book_translation_jobs", "custom_instructions")
    user_columns = {column["name"] for column in inspector.get_columns("users")}
    if "ai_translation_prompt" in user_columns:
        op.drop_column("users", "ai_translation_prompt")
