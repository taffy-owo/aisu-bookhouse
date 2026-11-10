"""add private bookshelf disliked state

Revision ID: 20260817_0035
Revises: 20260813_0034
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260817_0035"
down_revision: str | None = "20260813_0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("books") as batch:
        batch.add_column(sa.Column("disliked", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("books") as batch:
        batch.drop_column("disliked")
