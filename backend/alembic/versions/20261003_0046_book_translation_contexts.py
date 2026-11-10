"""Versioned translation context retained for owned book continuation."""
from alembic import op
import sqlalchemy as sa

revision = "20261003_0046"
down_revision = "20261003_0045"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("book_translation_contexts",
        sa.Column("book_id", sa.String(36), sa.ForeignKey("books.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("prompt", sa.Text(), nullable=True),
        sa.Column("context_json", sa.JSON(), nullable=False, server_default="{}"))


def downgrade() -> None:
    op.drop_table("book_translation_contexts")
