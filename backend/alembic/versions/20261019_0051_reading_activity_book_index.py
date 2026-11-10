"""Add the user/book index used by reading activity summaries."""

from alembic import op


revision = "20261019_0051"
down_revision = "20261018_0050"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_reading_activity_user_book",
        "reading_activity",
        ["user_id", "book_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_reading_activity_user_book", table_name="reading_activity")
