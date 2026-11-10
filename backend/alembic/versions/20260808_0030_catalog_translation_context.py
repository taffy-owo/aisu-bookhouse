"""track context-aware catalog translation

Revision ID: 20260808_0030
Revises: 20260808_0029
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260808_0030"
down_revision: str | None = "20260808_0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("whole_book_translation_jobs")}
    if "catalog_translation_version" not in columns:
        op.add_column(
            "whole_book_translation_jobs",
            sa.Column("catalog_translation_version", sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("whole_book_translation_jobs")}
    if "catalog_translation_version" in columns:
        op.drop_column("whole_book_translation_jobs", "catalog_translation_version")
