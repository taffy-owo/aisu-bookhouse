"""add translation project engine tables"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260526_0012"
down_revision: str | None = "20260523_0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "translation_projects" not in tables:
        op.create_table(
            "translation_projects",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("user_id", sa.String(length=36), nullable=False),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("source_language", sa.String(length=32), nullable=False),
            sa.Column("target_language", sa.String(length=32), nullable=False),
            sa.Column("style_prompt", sa.Text(), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("progress", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_translation_projects_user_id", "translation_projects", ["user_id"])
        op.create_index("ix_translation_projects_status", "translation_projects", ["status"])

    if "translation_chapters" not in tables:
        op.create_table(
            "translation_chapters",
            sa.Column("id", sa.String(length=64), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("index", sa.Integer(), nullable=False),
            sa.Column("title", sa.String(length=500), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("summary", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["project_id"], ["translation_projects.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_translation_chapters_project_id", "translation_chapters", ["project_id"])
        op.create_index("ix_translation_chapters_index", "translation_chapters", ["index"])
        op.create_index("ix_translation_chapters_status", "translation_chapters", ["status"])

    if "translation_paragraphs" not in tables:
        op.create_table(
            "translation_paragraphs",
            sa.Column("id", sa.String(length=80), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("chapter_id", sa.String(length=64), nullable=False),
            sa.Column("index", sa.Integer(), nullable=False),
            sa.Column("source_text", sa.Text(), nullable=False),
            sa.Column("translated_text", sa.Text(), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("locked", sa.Boolean(), nullable=False),
            sa.Column("quality_issues", sa.Text(), nullable=False),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["chapter_id"], ["translation_chapters.id"]),
            sa.ForeignKeyConstraint(["project_id"], ["translation_projects.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_translation_paragraphs_project_id", "translation_paragraphs", ["project_id"])
        op.create_index("ix_translation_paragraphs_chapter_id", "translation_paragraphs", ["chapter_id"])
        op.create_index("ix_translation_paragraphs_index", "translation_paragraphs", ["index"])
        op.create_index("ix_translation_paragraphs_status", "translation_paragraphs", ["status"])

    if "translation_terms" not in tables:
        op.create_table(
            "translation_terms",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("source_term", sa.String(length=255), nullable=False),
            sa.Column("target_term", sa.String(length=255), nullable=False),
            sa.Column("type", sa.String(length=32), nullable=False),
            sa.Column("aliases", sa.Text(), nullable=False),
            sa.Column("locked", sa.Boolean(), nullable=False),
            sa.Column("note", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["project_id"], ["translation_projects.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_translation_terms_project_id", "translation_terms", ["project_id"])
        op.create_index("ix_translation_terms_source_term", "translation_terms", ["source_term"])

    if "translation_operations" not in tables:
        op.create_table(
            "translation_operations",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("chapter_id", sa.String(length=64), nullable=True),
            sa.Column("type", sa.String(length=32), nullable=False),
            sa.Column("scope", sa.String(length=32), nullable=False),
            sa.Column("instruction", sa.Text(), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("affected_paragraph_count", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["project_id"], ["translation_projects.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_translation_operations_project_id", "translation_operations", ["project_id"])
        op.create_index("ix_translation_operations_chapter_id", "translation_operations", ["chapter_id"])
        op.create_index("ix_translation_operations_type", "translation_operations", ["type"])
        op.create_index("ix_translation_operations_status", "translation_operations", ["status"])

    if "translation_revisions" not in tables:
        op.create_table(
            "translation_revisions",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("operation_id", sa.String(length=36), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("chapter_id", sa.String(length=64), nullable=False),
            sa.Column("paragraph_id", sa.String(length=80), nullable=False),
            sa.Column("before_text", sa.Text(), nullable=False),
            sa.Column("after_text", sa.Text(), nullable=False),
            sa.Column("operation_type", sa.String(length=32), nullable=False),
            sa.Column("instruction", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["operation_id"], ["translation_operations.id"]),
            sa.ForeignKeyConstraint(["project_id"], ["translation_projects.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_translation_revisions_operation_id", "translation_revisions", ["operation_id"])
        op.create_index("ix_translation_revisions_project_id", "translation_revisions", ["project_id"])
        op.create_index("ix_translation_revisions_chapter_id", "translation_revisions", ["chapter_id"])
        op.create_index("ix_translation_revisions_paragraph_id", "translation_revisions", ["paragraph_id"])
        op.create_index("ix_translation_revisions_operation_type", "translation_revisions", ["operation_type"])

    if "translation_jobs" not in tables:
        op.create_table(
            "translation_jobs",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("type", sa.String(length=32), nullable=False),
            sa.Column("scope", sa.String(length=32), nullable=False),
            sa.Column("chapter_id", sa.String(length=64), nullable=True),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("total_count", sa.Integer(), nullable=False),
            sa.Column("completed_count", sa.Integer(), nullable=False),
            sa.Column("failed_count", sa.Integer(), nullable=False),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("cancel_requested", sa.Boolean(), nullable=False),
            sa.Column("retry_count", sa.Integer(), nullable=False),
            sa.Column("model", sa.String(length=160), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["project_id"], ["translation_projects.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_translation_jobs_project_id", "translation_jobs", ["project_id"])
        op.create_index("ix_translation_jobs_type", "translation_jobs", ["type"])
        op.create_index("ix_translation_jobs_chapter_id", "translation_jobs", ["chapter_id"])
        op.create_index("ix_translation_jobs_status", "translation_jobs", ["status"])

    if "translation_job_items" not in tables:
        op.create_table(
            "translation_job_items",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("job_id", sa.String(length=36), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("chapter_id", sa.String(length=64), nullable=False),
            sa.Column("paragraph_id", sa.String(length=80), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("retry_count", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["job_id"], ["translation_jobs.id"]),
            sa.ForeignKeyConstraint(["project_id"], ["translation_projects.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_translation_job_items_job_id", "translation_job_items", ["job_id"])
        op.create_index("ix_translation_job_items_project_id", "translation_job_items", ["project_id"])
        op.create_index("ix_translation_job_items_chapter_id", "translation_job_items", ["chapter_id"])
        op.create_index("ix_translation_job_items_paragraph_id", "translation_job_items", ["paragraph_id"])
        op.create_index("ix_translation_job_items_status", "translation_job_items", ["status"])

    if "translation_chat_messages" not in tables:
        op.create_table(
            "translation_chat_messages",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("chapter_id", sa.String(length=64), nullable=True),
            sa.Column("role", sa.String(length=16), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("scope", sa.String(length=32), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["project_id"], ["translation_projects.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_translation_chat_messages_project_id", "translation_chat_messages", ["project_id"])
        op.create_index("ix_translation_chat_messages_chapter_id", "translation_chat_messages", ["chapter_id"])

    if "translation_export_jobs" not in tables:
        op.create_table(
            "translation_export_jobs",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("format", sa.String(length=16), nullable=False),
            sa.Column("mode", sa.String(length=32), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("file_url", sa.Text(), nullable=True),
            sa.Column("storage_path", sa.Text(), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(["project_id"], ["translation_projects.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_translation_export_jobs_project_id", "translation_export_jobs", ["project_id"])
        op.create_index("ix_translation_export_jobs_status", "translation_export_jobs", ["status"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    for table_name, index_names in [
        ("translation_export_jobs", ["ix_translation_export_jobs_status", "ix_translation_export_jobs_project_id"]),
        ("translation_chat_messages", ["ix_translation_chat_messages_chapter_id", "ix_translation_chat_messages_project_id"]),
        (
            "translation_job_items",
            [
                "ix_translation_job_items_status",
                "ix_translation_job_items_paragraph_id",
                "ix_translation_job_items_chapter_id",
                "ix_translation_job_items_project_id",
                "ix_translation_job_items_job_id",
            ],
        ),
        ("translation_jobs", ["ix_translation_jobs_status", "ix_translation_jobs_chapter_id", "ix_translation_jobs_type", "ix_translation_jobs_project_id"]),
        (
            "translation_revisions",
            [
                "ix_translation_revisions_operation_type",
                "ix_translation_revisions_paragraph_id",
                "ix_translation_revisions_chapter_id",
                "ix_translation_revisions_project_id",
                "ix_translation_revisions_operation_id",
            ],
        ),
        ("translation_operations", ["ix_translation_operations_status", "ix_translation_operations_type", "ix_translation_operations_chapter_id", "ix_translation_operations_project_id"]),
        ("translation_terms", ["ix_translation_terms_source_term", "ix_translation_terms_project_id"]),
        ("translation_paragraphs", ["ix_translation_paragraphs_status", "ix_translation_paragraphs_index", "ix_translation_paragraphs_chapter_id", "ix_translation_paragraphs_project_id"]),
        ("translation_chapters", ["ix_translation_chapters_status", "ix_translation_chapters_index", "ix_translation_chapters_project_id"]),
        ("translation_projects", ["ix_translation_projects_status", "ix_translation_projects_user_id"]),
    ]:
        if table_name not in tables:
            continue
        for index_name in index_names:
            op.drop_index(index_name, table_name=table_name)
        op.drop_table(table_name)
