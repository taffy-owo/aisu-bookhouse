"""store a separate per-user audiobook AI provider

Revision ID: 20260801_0024
Revises: 20260801_0023
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260801_0024"
down_revision: str | None = "20260801_0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("users")}
    if "audiobook_provider_base_url" not in columns:
        op.add_column("users", sa.Column("audiobook_provider_base_url", sa.String(length=500), nullable=True))
    if "audiobook_provider_api_key_encrypted" not in columns:
        op.add_column("users", sa.Column("audiobook_provider_api_key_encrypted", sa.Text(), nullable=True))
    if "audiobook_tts_voice" not in columns:
        op.add_column("users", sa.Column("audiobook_tts_voice", sa.String(length=128), nullable=True))

    op.execute(
        sa.text(
            "UPDATE users SET "
            "audiobook_provider_base_url = ai_provider_base_url, "
            "audiobook_provider_api_key_encrypted = ai_provider_api_key_encrypted "
            "WHERE audiobook_tts_model IS NOT NULL AND audiobook_tts_model != ''"
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("users")}
    for column_name in (
        "audiobook_tts_voice",
        "audiobook_provider_api_key_encrypted",
        "audiobook_provider_base_url",
    ):
        if column_name in columns:
            op.drop_column("users", column_name)
