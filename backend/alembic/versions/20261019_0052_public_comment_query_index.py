"""Add the index used by public comment target queries."""

from alembic import op


revision = "20261019_0052"
down_revision = "20261019_0051"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_public_comments_target_created",
        "public_comments",
        ["book_id", "target_type", "target_index", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_public_comments_target_created", table_name="public_comments")
