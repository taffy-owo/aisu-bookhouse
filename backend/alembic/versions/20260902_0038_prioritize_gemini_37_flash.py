"""prioritize Gemini 3.7 Flash High with standard Flash fallback

Revision ID: 20260902_0038
Revises: 20260901_0037
"""

from collections.abc import Sequence
from datetime import datetime, timezone
from uuid import uuid4

from alembic import op
import sqlalchemy as sa

revision: str = "20260902_0038"
down_revision: str | None = "20260901_0037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


PRIMARY_MODEL = "gemini-3.7-flash-high"
PRIMARY_DISPLAY_NAME = "Gemini 3.7 Flash High"
SECONDARY_MODEL = "gemini-3-flash"
SECONDARY_DISPLAY_NAME = "Gemini 3 Flash"
MAX_CONCURRENCY = 4
CHUNK_CHARACTERS = 1800
CHUNK_PARAGRAPHS = 30


def upgrade() -> None:
    connection = op.get_bind()
    now = datetime.now(timezone.utc)
    channel_ids = connection.execute(
        sa.text("SELECT DISTINCT channel_id FROM ai_channel_models WHERE model = :model"),
        {"model": SECONDARY_MODEL},
    ).scalars().all()

    for channel_id in channel_ids:
        primary_id = connection.execute(
            sa.text(
                "SELECT id FROM ai_channel_models "
                "WHERE channel_id = :channel_id AND model = :model LIMIT 1"
            ),
            {"channel_id": channel_id, "model": PRIMARY_MODEL},
        ).scalar()
        if primary_id is None:
            connection.execute(
                sa.text(
                    "INSERT INTO ai_channel_models "
                    "(id, channel_id, model, display_name, enabled, sort_order, max_concurrency, "
                    "chunk_characters, chunk_paragraphs, unavailable_until, unavailable_reason, "
                    "created_at, updated_at) VALUES "
                    "(:id, :channel_id, :model, :display_name, 1, 0, :max_concurrency, "
                    ":chunk_characters, :chunk_paragraphs, NULL, NULL, :now, :now)"
                ),
                {
                    "id": str(uuid4()),
                    "channel_id": channel_id,
                    "model": PRIMARY_MODEL,
                    "display_name": PRIMARY_DISPLAY_NAME,
                    "max_concurrency": MAX_CONCURRENCY,
                    "chunk_characters": CHUNK_CHARACTERS,
                    "chunk_paragraphs": CHUNK_PARAGRAPHS,
                    "now": now,
                },
            )
        else:
            connection.execute(
                sa.text(
                    "UPDATE ai_channel_models SET display_name = :display_name, enabled = 1, "
                    "sort_order = 0, max_concurrency = :max_concurrency, "
                    "chunk_characters = :chunk_characters, chunk_paragraphs = :chunk_paragraphs, "
                    "unavailable_until = NULL, unavailable_reason = NULL, updated_at = :now "
                    "WHERE id = :id"
                ),
                {
                    "id": primary_id,
                    "display_name": PRIMARY_DISPLAY_NAME,
                    "max_concurrency": MAX_CONCURRENCY,
                    "chunk_characters": CHUNK_CHARACTERS,
                    "chunk_paragraphs": CHUNK_PARAGRAPHS,
                    "now": now,
                },
            )

        connection.execute(
            sa.text(
                "UPDATE ai_channel_models SET display_name = :display_name, enabled = 1, "
                "sort_order = 10, max_concurrency = :max_concurrency, "
                "chunk_characters = :chunk_characters, chunk_paragraphs = :chunk_paragraphs, "
                "unavailable_until = NULL, unavailable_reason = NULL, updated_at = :now "
                "WHERE channel_id = :channel_id AND model = :model"
            ),
            {
                "channel_id": channel_id,
                "model": SECONDARY_MODEL,
                "display_name": SECONDARY_DISPLAY_NAME,
                "max_concurrency": MAX_CONCURRENCY,
                "chunk_characters": CHUNK_CHARACTERS,
                "chunk_paragraphs": CHUNK_PARAGRAPHS,
                "now": now,
            },
        )
        connection.execute(
            sa.text(
                "UPDATE users SET ai_translation_model = :primary, "
                "ai_translation_concurrency = :concurrency, updated_at = :now "
                "WHERE id = (SELECT user_id FROM ai_channels WHERE id = :channel_id) "
                "AND (ai_translation_model IS NULL OR ai_translation_model IN (:secondary, :retired))"
            ),
            {
                "primary": PRIMARY_MODEL,
                "secondary": SECONDARY_MODEL,
                "retired": "gemini-3.6-flash-high",
                "concurrency": MAX_CONCURRENCY,
                "channel_id": channel_id,
                "now": now,
            },
        )
        # Jobs that are stopped at a checkpoint may safely adopt the preferred
        # model. A currently processing chapter keeps its selected model until
        # the next job, avoiding a mid-chapter context change.
        connection.execute(
            sa.text(
                "UPDATE whole_book_translation_jobs SET model = :primary, updated_at = :now "
                "WHERE channel_id = :channel_id AND model = :secondary "
                "AND status IN ('queued', 'paused', 'waiting_quota', 'failed')"
            ),
            {
                "primary": PRIMARY_MODEL,
                "secondary": SECONDARY_MODEL,
                "channel_id": channel_id,
                "now": now,
            },
        )


def downgrade() -> None:
    # Keep both callable rows on rollback; deleting a user-configured provider
    # option is riskier than leaving the operational preference in place.
    pass
