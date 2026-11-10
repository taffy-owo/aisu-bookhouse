"""Add kind column to upload tasks so the worker can tell reprocess tasks apart."""

from alembic import op
import sqlalchemy as sa

revision = "20260704_0018"
down_revision = "20260703_0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    task_columns = {column["name"] for column in inspector.get_columns("upload_tasks")}
    if "kind" not in task_columns:
        op.add_column("upload_tasks", sa.Column("kind", sa.String(length=16), nullable=False, server_default="initial"))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    task_columns = {column["name"] for column in inspector.get_columns("upload_tasks")}
    if "kind" in task_columns:
        op.drop_column("upload_tasks", "kind")
