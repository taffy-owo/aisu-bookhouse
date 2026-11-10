"""Persist external-agent projects and per-chapter checkpoints."""

from alembic import op
import sqlalchemy as sa

revision = "20261003_0043"
down_revision = "20260926_0042"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_projects",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("context_json", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("book_id", sa.String(36), nullable=True),
        sa.Column("publication_json", sa.JSON(), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=True),
        sa.Column("token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_agent_projects_owner_id", "agent_projects", ["owner_id"])
    op.create_table(
        "agent_chapters",
        sa.Column("project_id", sa.String(36), sa.ForeignKey("agent_projects.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("index", sa.Integer(), primary_key=True),
        sa.Column("source_json", sa.JSON(), nullable=False),
        sa.Column("source_hash", sa.String(64), nullable=False),
        sa.Column("translation_json", sa.JSON(), nullable=True),
        sa.Column("translation_hash", sa.String(64), nullable=True),
        sa.Column("translation_characters", sa.Integer(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("agent_chapters")
    op.drop_index("ix_agent_projects_owner_id", table_name="agent_projects")
    op.drop_table("agent_projects")
