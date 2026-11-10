"""Add owner-scoped ordering indexes for task lists."""

from alembic import op


revision = "20261018_0049"
down_revision = "20261018_0048"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_upload_tasks_user_updated_created",
        "upload_tasks",
        ["user_id", "updated_at", "created_at"],
    )
    op.create_index(
        "ix_translation_jobs_user_updated_id",
        "whole_book_translation_jobs",
        ["user_id", "updated_at", "id"],
    )
    op.create_index(
        "ix_translation_jobs_user_book_updated_id",
        "whole_book_translation_jobs",
        ["user_id", "book_id", "updated_at", "id"],
    )


def downgrade() -> None:
    op.drop_index("ix_translation_jobs_user_book_updated_id", table_name="whole_book_translation_jobs")
    op.drop_index("ix_translation_jobs_user_updated_id", table_name="whole_book_translation_jobs")
    op.drop_index("ix_upload_tasks_user_updated_created", table_name="upload_tasks")
