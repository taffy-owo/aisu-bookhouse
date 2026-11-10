"""Keep manual language choices separate from automatic recognition."""

from alembic import op
import sqlalchemy as sa


revision = "20261025_0054"
down_revision = "20261024_0053"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # NULL retains legacy provenance without guessing or rewriting book data.
    op.add_column("books", sa.Column("language_mode", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("books", "language_mode")
