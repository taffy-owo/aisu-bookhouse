"""move translation traffic from the small high-model quota to standard Flash

Revision ID: 20260901_0037
Revises: 20260901_0036
"""

from collections.abc import Sequence
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa

revision: str = "20260901_0037"
down_revision: str | None = "20260901_0036"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


OLD_MODEL = "gemini-3.6-flash-high"
NEW_MODEL = "gemini-3-flash"
NEW_DISPLAY_NAME = "Gemini 3 Flash"
NEW_MAX_CONCURRENCY = 4
NEW_CHUNK_CHARACTERS = 1800
NEW_CHUNK_PARAGRAPHS = 30
UNFINISHED_STATUSES = ("queued", "processing", "waiting_quota", "paused", "review_pending")


def upgrade() -> None:
    connection = op.get_bind()
    now = datetime.now(timezone.utc)

    # A user may already have added gemini-3-flash manually. Merge the old High
    # row into that row instead of violating the per-channel unique constraint.
    old_rows = connection.execute(
        sa.text("SELECT id, channel_id FROM ai_channel_models WHERE model = :model"),
        {"model": OLD_MODEL},
    ).fetchall()
    for old_id, channel_id in old_rows:
        existing_id = connection.execute(
            sa.text(
                "SELECT id FROM ai_channel_models "
                "WHERE channel_id = :channel_id AND model = :model LIMIT 1"
            ),
            {"channel_id": channel_id, "model": NEW_MODEL},
        ).scalar()
        if existing_id:
            connection.execute(
                sa.text("DELETE FROM ai_channel_models WHERE id = :id"),
                {"id": old_id},
            )
        else:
            connection.execute(
                sa.text(
                    "UPDATE ai_channel_models SET model = :model, display_name = :display_name, "
                    "enabled = 1, max_concurrency = :max_concurrency, "
                    "chunk_characters = :chunk_characters, chunk_paragraphs = :chunk_paragraphs, "
                    "unavailable_until = NULL, unavailable_reason = NULL, updated_at = :now "
                    "WHERE id = :id"
                ),
                {
                    "id": old_id,
                    "model": NEW_MODEL,
                    "display_name": NEW_DISPLAY_NAME,
                    "max_concurrency": NEW_MAX_CONCURRENCY,
                    "chunk_characters": NEW_CHUNK_CHARACTERS,
                    "chunk_paragraphs": NEW_CHUNK_PARAGRAPHS,
                    "now": now,
                },
            )

    connection.execute(
        sa.text(
            "UPDATE ai_channel_models SET display_name = :display_name, enabled = 1, "
            "max_concurrency = :max_concurrency, chunk_characters = :chunk_characters, "
            "chunk_paragraphs = :chunk_paragraphs, unavailable_until = NULL, "
            "unavailable_reason = NULL, updated_at = :now WHERE model = :model"
        ),
        {
            "model": NEW_MODEL,
            "display_name": NEW_DISPLAY_NAME,
            "max_concurrency": NEW_MAX_CONCURRENCY,
            "chunk_characters": NEW_CHUNK_CHARACTERS,
            "chunk_paragraphs": NEW_CHUNK_PARAGRAPHS,
            "now": now,
        },
    )
    connection.execute(
        sa.text(
            "UPDATE users SET ai_translation_model = :new_model, "
            "ai_translation_concurrency = :concurrency, updated_at = :now "
            "WHERE ai_translation_model = :old_model"
        ),
        {
            "new_model": NEW_MODEL,
            "old_model": OLD_MODEL,
            "concurrency": NEW_MAX_CONCURRENCY,
            "now": now,
        },
    )
    # Completed jobs retain the model that actually produced their text. Only
    # work that can still make another provider call is moved to the new lane.
    connection.execute(
        sa.text(
            "UPDATE whole_book_translation_jobs SET model = :new_model, updated_at = :now "
            "WHERE model = :old_model AND status IN :statuses"
        ).bindparams(sa.bindparam("statuses", expanding=True)),
        {
            "new_model": NEW_MODEL,
            "old_model": OLD_MODEL,
            "statuses": UNFINISHED_STATUSES,
            "now": now,
        },
    )


def downgrade() -> None:
    # This is an operational quota migration. Recreating a retired provider row
    # on downgrade could silently send new work back into an exhausted pool.
    pass
