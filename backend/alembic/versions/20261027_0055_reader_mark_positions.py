"""Retain reader notes when their published position becomes invalid."""

from alembic import op
import sqlalchemy as sa

revision = "20261027_0055"
down_revision = "20261025_0054"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("reader_marks", sa.Column("position_key", sa.String(128), nullable=True))
    op.add_column("reader_marks", sa.Column("position_valid", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    op.drop_column("reader_marks", "position_valid")
    op.drop_column("reader_marks", "position_key")
