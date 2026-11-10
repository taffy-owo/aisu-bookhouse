"""reader marks"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260522_0004"
down_revision: str | None = "20260520_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reader_marks",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("book_id", sa.String(), nullable=False),
        sa.Column("reader_type", sa.String(length=32), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("chapter_index", sa.Integer(), nullable=True),
        sa.Column("image_index", sa.Integer(), nullable=True),
        sa.Column("page_number", sa.Integer(), nullable=True),
        sa.Column("epub_cfi", sa.String(length=1000), nullable=True),
        sa.Column("progress_percent", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["book_id"], ["books.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_reader_marks_book_id"), "reader_marks", ["book_id"], unique=False)
    op.create_index(op.f("ix_reader_marks_user_id"), "reader_marks", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_reader_marks_user_id"), table_name="reader_marks")
    op.drop_index(op.f("ix_reader_marks_book_id"), table_name="reader_marks")
    op.drop_table("reader_marks")
