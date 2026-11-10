"""store per-user AI model preferences

Revision ID: 20260801_0022
Revises: 20260721_0021
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260801_0022"
down_revision: str | None = "20260721_0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("users")}
    if "ai_translation_model" not in columns:
        op.add_column("users", sa.Column("ai_translation_model", sa.String(length=128), nullable=True))
    if "audiobook_tts_model" not in columns:
        op.add_column("users", sa.Column("audiobook_tts_model", sa.String(length=128), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("users")}
    if "audiobook_tts_model" in columns:
        op.drop_column("users", "audiobook_tts_model")
    if "ai_translation_model" in columns:
        op.drop_column("users", "ai_translation_model")
