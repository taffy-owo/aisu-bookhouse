"""add public share metadata"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260523_0011"
down_revision: str | None = "20260523_0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    book_columns = {column["name"] for column in inspector.get_columns("books")}

    if "public_share_note" not in book_columns:
        op.add_column("books", sa.Column("public_share_note", sa.Text(), nullable=True))
    if "public_source_note" not in book_columns:
        op.add_column("books", sa.Column("public_source_note", sa.Text(), nullable=True))
    if "public_download_allowed" not in book_columns:
        op.add_column("books", sa.Column("public_download_allowed", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    book_columns = {column["name"] for column in inspector.get_columns("books")}

    for column_name in ["public_download_allowed", "public_source_note", "public_share_note"]:
        if column_name in book_columns:
            op.drop_column("books", column_name)
