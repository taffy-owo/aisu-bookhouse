"""store encrypted per-user AI provider credentials

Revision ID: 20260801_0023
Revises: 20260801_0022
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260801_0023"
down_revision: str | None = "20260801_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("users")}
    if "ai_provider_base_url" not in columns:
        op.add_column("users", sa.Column("ai_provider_base_url", sa.String(length=500), nullable=True))
    if "ai_provider_api_key_encrypted" not in columns:
        op.add_column("users", sa.Column("ai_provider_api_key_encrypted", sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("users")}
    if "ai_provider_api_key_encrypted" in columns:
        op.drop_column("users", "ai_provider_api_key_encrypted")
    if "ai_provider_base_url" in columns:
        op.drop_column("users", "ai_provider_base_url")
