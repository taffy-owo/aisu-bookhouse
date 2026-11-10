"""disable automatic source update translation

Revision ID: 20260809_0033
Revises: 20260809_0032
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260809_0033"
down_revision: str | None = "20260809_0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("UPDATE books SET auto_translate_updates = 0 WHERE auto_translate_updates != 0")


def downgrade() -> None:
    pass
