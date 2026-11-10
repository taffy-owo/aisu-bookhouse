"""add translation job progress tracking fields"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260526_0013"
down_revision: str | None = "20260526_0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "translation_jobs" not in tables:
        return

    columns = {column["name"] for column in inspector.get_columns("translation_jobs")}
    with op.batch_alter_table("translation_jobs") as batch_op:
        if "current_chapter_id" not in columns:
            batch_op.add_column(sa.Column("current_chapter_id", sa.String(length=64), nullable=True))
        if "current_paragraph_id" not in columns:
            batch_op.add_column(sa.Column("current_paragraph_id", sa.String(length=80), nullable=True))
        if "progress" not in columns:
            batch_op.add_column(sa.Column("progress", sa.Integer(), nullable=False, server_default="0"))

    indexes = {index["name"] for index in inspector.get_indexes("translation_jobs")}
    if "ix_translation_jobs_current_chapter_id" not in indexes:
        op.create_index("ix_translation_jobs_current_chapter_id", "translation_jobs", ["current_chapter_id"])
    if "ix_translation_jobs_current_paragraph_id" not in indexes:
        op.create_index("ix_translation_jobs_current_paragraph_id", "translation_jobs", ["current_paragraph_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "translation_jobs" not in tables:
        return

    indexes = {index["name"] for index in inspector.get_indexes("translation_jobs")}
    if "ix_translation_jobs_current_paragraph_id" in indexes:
        op.drop_index("ix_translation_jobs_current_paragraph_id", table_name="translation_jobs")
    if "ix_translation_jobs_current_chapter_id" in indexes:
        op.drop_index("ix_translation_jobs_current_chapter_id", table_name="translation_jobs")

    columns = {column["name"] for column in inspector.get_columns("translation_jobs")}
    with op.batch_alter_table("translation_jobs") as batch_op:
        if "progress" in columns:
            batch_op.drop_column("progress")
        if "current_paragraph_id" in columns:
            batch_op.drop_column("current_paragraph_id")
        if "current_chapter_id" in columns:
            batch_op.drop_column("current_chapter_id")
