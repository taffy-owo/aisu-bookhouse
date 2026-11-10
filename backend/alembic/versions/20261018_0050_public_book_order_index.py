"""Add the public shelf ordering index."""

from alembic import op


revision = "20261018_0050"
down_revision = "20261018_0049"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_books_public_status_updated_id",
        "books",
        ["public_status", "status", "updated_at", "id"],
    )


def downgrade() -> None:
    op.drop_index("ix_books_public_status_updated_id", table_name="books")
