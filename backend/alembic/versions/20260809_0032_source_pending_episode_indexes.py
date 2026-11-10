"""track pending source episode indexes

Revision ID: 20260809_0032
Revises: 20260809_0031
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260809_0032"
down_revision: str | None = "20260809_0031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("books")}
    if "source_pending_episode_indexes" not in columns:
        op.add_column(
            "books",
            sa.Column("source_pending_episode_indexes", sa.JSON(), nullable=False, server_default="[]"),
        )


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("books")}
    if "source_pending_episode_indexes" in columns:
        op.drop_column("books", "source_pending_episode_indexes")
