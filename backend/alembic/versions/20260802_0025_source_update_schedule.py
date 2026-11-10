"""store source website update schedules

Revision ID: 20260802_0025
Revises: 20260801_0024
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260802_0025"
down_revision: str | None = "20260801_0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("books")}
    additions = (
        ("source_schedule_time", sa.Column("source_schedule_time", sa.String(length=5), nullable=True)),
        ("source_schedule_timezone", sa.Column("source_schedule_timezone", sa.String(length=64), nullable=True)),
        ("source_schedule_label", sa.Column("source_schedule_label", sa.String(length=120), nullable=True)),
    )
    for name, column in additions:
        if name not in columns:
            op.add_column("books", column)


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("books")}
    for name in ("source_schedule_label", "source_schedule_timezone", "source_schedule_time"):
        if name in columns:
            op.drop_column("books", name)
