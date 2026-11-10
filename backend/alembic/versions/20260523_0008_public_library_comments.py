"""add public library sharing and comments"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260523_0008"
down_revision: str | None = "20260522_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    book_columns = [col["name"] for col in inspector.get_columns("books")]

    if "public_status" not in book_columns:
        op.add_column("books", sa.Column("public_status", sa.String(length=32), nullable=False, server_default="private"))
    if "public_requested_at" not in book_columns:
        op.add_column("books", sa.Column("public_requested_at", sa.DateTime(timezone=True), nullable=True))
    if "public_approved_at" not in book_columns:
        op.add_column("books", sa.Column("public_approved_at", sa.DateTime(timezone=True), nullable=True))
    if "public_rejected_at" not in book_columns:
        op.add_column("books", sa.Column("public_rejected_at", sa.DateTime(timezone=True), nullable=True))
    if "public_moderated_by" not in book_columns:
        op.add_column("books", sa.Column("public_moderated_by", sa.String(length=36), nullable=True))

    indexes = [index["name"] for index in inspector.get_indexes("books")]
    if "ix_books_public_status" not in indexes:
        op.create_index("ix_books_public_status", "books", ["public_status"])

    tables = inspector.get_table_names()
    if "public_comments" not in tables:
        op.create_table(
            "public_comments",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("book_id", sa.String(length=36), nullable=False),
            sa.Column("user_id", sa.String(length=36), nullable=False),
            sa.Column("target_type", sa.String(length=20), nullable=False),
            sa.Column("target_index", sa.Integer(), nullable=True),
            sa.Column("body", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(["book_id"], ["books.id"]),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_public_comments_book_id", "public_comments", ["book_id"])
        op.create_index("ix_public_comments_user_id", "public_comments", ["user_id"])
        op.create_index("ix_public_comments_target_type", "public_comments", ["target_type"])
        op.create_index("ix_public_comments_target_index", "public_comments", ["target_index"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = inspector.get_table_names()
    if "public_comments" in tables:
        op.drop_index("ix_public_comments_target_index", table_name="public_comments")
        op.drop_index("ix_public_comments_target_type", table_name="public_comments")
        op.drop_index("ix_public_comments_user_id", table_name="public_comments")
        op.drop_index("ix_public_comments_book_id", table_name="public_comments")
        op.drop_table("public_comments")

    indexes = [index["name"] for index in inspector.get_indexes("books")]
    if "ix_books_public_status" in indexes:
        op.drop_index("ix_books_public_status", table_name="books")

    book_columns = [col["name"] for col in inspector.get_columns("books")]
    for column_name in ["public_moderated_by", "public_rejected_at", "public_approved_at", "public_requested_at", "public_status"]:
        if column_name in book_columns:
            with op.batch_alter_table("books") as batch_op:
                batch_op.drop_column(column_name)
