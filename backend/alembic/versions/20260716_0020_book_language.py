"""add structured book language metadata

Revision ID: 20260716_0020
Revises: 20260710_0019
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260716_0020"
down_revision: str | None = "20260710_0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("books")}
    if "language" not in columns:
        op.add_column("books", sa.Column("language", sa.String(length=16), nullable=False, server_default="und"))
        op.create_index("ix_books_language", "books", ["language"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("books")}
    if "language" in columns:
        op.drop_index("ix_books_language", table_name="books")
        op.drop_column("books", "language")
