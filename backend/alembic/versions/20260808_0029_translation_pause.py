"""add cooperative pause state to whole-book translation jobs

Revision ID: 20260808_0029
Revises: 20260808_0028
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260808_0029"
down_revision: str | None = "20260808_0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("whole_book_translation_jobs")}
    if "pause_requested" not in columns:
        op.add_column(
            "whole_book_translation_jobs",
            sa.Column("pause_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("whole_book_translation_jobs")}
    if "pause_requested" in columns:
        op.drop_column("whole_book_translation_jobs", "pause_requested")
