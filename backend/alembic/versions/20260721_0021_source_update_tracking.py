"""track source website updates for ongoing books

Revision ID: 20260721_0021
Revises: 20260716_0020
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260721_0021"
down_revision: str | None = "20260716_0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("books")}
    additions = (
        ("source_episode_count", sa.Column("source_episode_count", sa.Integer(), nullable=True)),
        ("source_character_count", sa.Column("source_character_count", sa.Integer(), nullable=True)),
        ("source_update_count", sa.Column("source_update_count", sa.Integer(), nullable=False, server_default="0")),
        ("source_checked_at", sa.Column("source_checked_at", sa.DateTime(timezone=True), nullable=True)),
        ("source_check_error", sa.Column("source_check_error", sa.String(length=500), nullable=True)),
    )
    for name, column in additions:
        if name not in columns:
            op.add_column("books", column)


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("books")}
    for name in (
        "source_check_error",
        "source_checked_at",
        "source_update_count",
        "source_character_count",
        "source_episode_count",
    ):
        if name in columns:
            op.drop_column("books", name)
