"""multi-channel AI translation config

Revision ID: 20260813_0034
Revises: 20260809_0033
"""

from collections.abc import Sequence
from datetime import datetime, timezone
from uuid import uuid4

from alembic import op
import sqlalchemy as sa

revision: str = "20260813_0034"
down_revision: str | None = "20260809_0033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


DEFAULT_MAX_CONCURRENCY = 4
DEFAULT_CHUNK_CHARACTERS = 4500
DEFAULT_CHUNK_PARAGRAPHS = 220
# The channel this deployment used to hardcode as the secondary lane. It no
# longer exists upstream, so jobs auto-assigned to it could never succeed and
# it must not be carried into the new tables.
RETIRED_MODELS = ("deepseek-v4-flash",)


def upgrade() -> None:
    op.create_table(
        "ai_channels",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("base_url", sa.String(length=500), nullable=False),
        sa.Column("api_key_encrypted", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_ai_channels_user_id", "ai_channels", ["user_id"])

    op.create_table(
        "ai_channel_models",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("channel_id", sa.String(length=36), sa.ForeignKey("ai_channels.id"), nullable=False),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("display_name", sa.String(length=160), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_concurrency", sa.Integer(), nullable=False, server_default=str(DEFAULT_MAX_CONCURRENCY)),
        sa.Column("chunk_characters", sa.Integer(), nullable=False, server_default=str(DEFAULT_CHUNK_CHARACTERS)),
        sa.Column("chunk_paragraphs", sa.Integer(), nullable=False, server_default=str(DEFAULT_CHUNK_PARAGRAPHS)),
        sa.Column("unavailable_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("unavailable_reason", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("channel_id", "model", name="uq_ai_channel_models_channel_model"),
    )
    op.create_index("ix_ai_channel_models_channel_id", "ai_channel_models", ["channel_id"])

    with op.batch_alter_table("whole_book_translation_jobs") as batch:
        batch.add_column(sa.Column("channel_id", sa.String(length=36), nullable=True))
        batch.add_column(
            sa.Column("provider_failure_streak", sa.Integer(), nullable=False, server_default="0")
        )
        batch.add_column(sa.Column("quota_resume_at", sa.DateTime(timezone=True), nullable=True))

    _backfill_channels()


def _backfill_channels() -> None:
    """Turn each user's single stored provider into their first channel."""
    connection = op.get_bind()
    users = connection.execute(
        sa.text(
            """
            SELECT id, ai_provider_base_url, ai_provider_api_key_encrypted, ai_translation_model
            FROM users
            WHERE ai_provider_base_url IS NOT NULL
              AND ai_provider_base_url != ''
              AND ai_provider_api_key_encrypted IS NOT NULL
              AND ai_provider_api_key_encrypted != ''
            """
        )
    ).fetchall()
    now = datetime.now(timezone.utc)
    for user_id, base_url, api_key_encrypted, translation_model in users:
        channel_id = str(uuid4())
        connection.execute(
            sa.text(
                """
                INSERT INTO ai_channels
                    (id, user_id, name, base_url, api_key_encrypted, enabled, sort_order, created_at, updated_at)
                VALUES (:id, :user_id, :name, :base_url, :api_key, 1, 0, :now, :now)
                """
            ),
            {
                "id": channel_id,
                "user_id": user_id,
                "name": "默认渠道",
                "base_url": base_url,
                "api_key": api_key_encrypted,
                "now": now,
            },
        )
        # Seed the channel with every model that user has actually run a job on,
        # so existing tasks keep resolving after the switch to channel-scoped
        # models. Retired names are skipped: keeping them would let the picker
        # offer a model the gateway no longer serves.
        models = [
            row[0]
            for row in connection.execute(
                sa.text(
                    """
                    SELECT DISTINCT model FROM whole_book_translation_jobs
                    WHERE user_id = :user_id AND model IS NOT NULL AND model != ''
                    """
                ),
                {"user_id": user_id},
            ).fetchall()
        ]
        if translation_model and translation_model not in models:
            models.insert(0, translation_model)
        for position, model in enumerate(model for model in models if model not in RETIRED_MODELS):
            connection.execute(
                sa.text(
                    """
                    INSERT INTO ai_channel_models
                        (id, channel_id, model, display_name, enabled, sort_order,
                         max_concurrency, chunk_characters, chunk_paragraphs, created_at, updated_at)
                    VALUES (:id, :channel_id, :model, NULL, 1, :sort_order,
                            :max_concurrency, :chunk_characters, :chunk_paragraphs, :now, :now)
                    """
                ),
                {
                    "id": str(uuid4()),
                    "channel_id": channel_id,
                    "model": model,
                    "sort_order": position,
                    "max_concurrency": DEFAULT_MAX_CONCURRENCY,
                    "chunk_characters": DEFAULT_CHUNK_CHARACTERS,
                    "chunk_paragraphs": DEFAULT_CHUNK_PARAGRAPHS,
                    "now": now,
                },
            )
        connection.execute(
            sa.text(
                "UPDATE whole_book_translation_jobs SET channel_id = :channel_id WHERE user_id = :user_id"
            ),
            {"channel_id": channel_id, "user_id": user_id},
        )


def downgrade() -> None:
    with op.batch_alter_table("whole_book_translation_jobs") as batch:
        batch.drop_column("quota_resume_at")
        batch.drop_column("provider_failure_streak")
        batch.drop_column("channel_id")
    op.drop_index("ix_ai_channel_models_channel_id", table_name="ai_channel_models")
    op.drop_table("ai_channel_models")
    op.drop_index("ix_ai_channels_user_id", table_name="ai_channels")
    op.drop_table("ai_channels")
