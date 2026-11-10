"""enable automatic translation for ongoing linked novels

Revision ID: 20260901_0036
Revises: 20260817_0035
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260901_0036"
down_revision: str | None = "20260817_0035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "UPDATE books SET auto_translate_updates = 1 "
        "WHERE status != 'deleted' AND kind = 'novel' AND publication_status = 'ongoing' "
        "AND source_url IS NOT NULL AND source_url != ''"
    )
    with op.batch_alter_table("books") as batch:
        batch.alter_column(
            "auto_translate_updates",
            existing_type=sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        )


def downgrade() -> None:
    with op.batch_alter_table("books") as batch:
        batch.alter_column(
            "auto_translate_updates",
            existing_type=sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        )
