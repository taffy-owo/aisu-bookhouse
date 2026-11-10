"""add resumable whole-book translation jobs

Revision ID: 20260802_0026
Revises: 20260802_0025
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260802_0026"
down_revision: str | None = "20260802_0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if "whole_book_translation_jobs" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "whole_book_translation_jobs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("book_id", sa.String(length=36), nullable=True),
        sa.Column("source_url", sa.String(length=1000), nullable=False),
        sa.Column("source_provider", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("author", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("stage", sa.String(length=32), nullable=False),
        sa.Column("progress", sa.Integer(), nullable=False),
        sa.Column("total_chapters", sa.Integer(), nullable=False),
        sa.Column("completed_chapters", sa.Integer(), nullable=False),
        sa.Column("current_chapter_index", sa.Integer(), nullable=True),
        sa.Column("message", sa.String(length=500), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("model", sa.String(length=160), nullable=False),
        sa.Column("provider_base_url", sa.String(length=500), nullable=False),
        sa.Column("provider_api_key_encrypted", sa.Text(), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("translated_metadata_json", sa.JSON(), nullable=False),
        sa.Column("catalog_json", sa.JSON(), nullable=False),
        sa.Column("memory_json", sa.JSON(), nullable=False),
        sa.Column("quality_report_json", sa.JSON(), nullable=False),
        sa.Column("acknowledged", sa.Boolean(), nullable=False),
        sa.Column("retry_count", sa.Integer(), nullable=False),
        sa.Column("lease_owner", sa.String(length=64), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["book_id"], ["books.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_whole_book_translation_jobs_user_id", "whole_book_translation_jobs", ["user_id"])
    op.create_index("ix_whole_book_translation_jobs_book_id", "whole_book_translation_jobs", ["book_id"])
    op.create_index("ix_whole_book_translation_jobs_source_url", "whole_book_translation_jobs", ["source_url"])
    op.create_index("ix_whole_book_translation_jobs_status", "whole_book_translation_jobs", ["status"])
    op.create_index("ix_whole_book_translation_jobs_acknowledged", "whole_book_translation_jobs", ["acknowledged"])
    op.create_index("ix_whole_book_translation_jobs_lease_owner", "whole_book_translation_jobs", ["lease_owner"])
    op.create_index("ix_whole_book_translation_jobs_lease_expires_at", "whole_book_translation_jobs", ["lease_expires_at"])


def downgrade() -> None:
    if "whole_book_translation_jobs" in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table("whole_book_translation_jobs")
