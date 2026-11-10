"""Add targeted indexes for owner-scoped bookshelf pages."""

from alembic import op

revision = "20260926_0042"
down_revision = "20260926_0041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_books_owner_created_id", "books", ["owner_id", "created_at", "id"])
    op.create_index("ix_books_owner_favorite_updated", "books", ["owner_id", "favorite", "updated_at"])


def downgrade() -> None:
    op.drop_index("ix_books_owner_favorite_updated", table_name="books")
    op.drop_index("ix_books_owner_created_id", table_name="books")
