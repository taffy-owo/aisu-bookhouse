"""Identify the one channel linked to the single-provider settings."""

from alembic import op
import sqlalchemy as sa


revision = "20261024_0053"
down_revision = "20261019_0052"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_channels", sa.Column("is_provider_default", sa.Boolean(), nullable=False, server_default=sa.false()))
    # Adopt only an unambiguous old default with the exact saved credentials.
    # A manually named channel is never inferred to belong to this form.
    op.execute(sa.text("""
        UPDATE ai_channels SET is_provider_default = TRUE WHERE id IN (
            SELECT c.id FROM ai_channels c JOIN users u ON u.id = c.user_id
            WHERE c.name = '默认渠道'
              AND c.base_url = u.ai_provider_base_url
              AND c.api_key_encrypted = u.ai_provider_api_key_encrypted
              AND NOT EXISTS (
                  SELECT 1 FROM ai_channels other WHERE other.user_id = c.user_id
                    AND other.id <> c.id AND other.name = '默认渠道'
                    AND other.base_url = c.base_url AND other.api_key_encrypted = c.api_key_encrypted
              )
        )
    """))
    op.create_index("uq_ai_channels_provider_default", "ai_channels", ["user_id"], unique=True,
        sqlite_where=sa.text("is_provider_default = 1"), postgresql_where=sa.text("is_provider_default"))


def downgrade() -> None:
    op.drop_index("uq_ai_channels_provider_default", table_name="ai_channels")
    op.drop_column("ai_channels", "is_provider_default")
