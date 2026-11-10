"""replace standard Flash fallback with Gemini 3.6 Flash High

Revision ID: 20260904_0039
Revises: 20260902_0038
"""

from collections.abc import Sequence
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa

revision: str = "20260904_0039"
down_revision: str | None = "20260902_0038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


OLD_MODEL = "gemini-3-flash"
NEW_MODEL = "gemini-3.6-flash-high"
NEW_DISPLAY_NAME = "Gemini 3.6 Flash High"


def upgrade() -> None:
    connection = op.get_bind()
    now = datetime.now(timezone.utc)
    channel_ids = connection.execute(
        sa.text("SELECT DISTINCT channel_id FROM ai_channel_models WHERE model = :model AND enabled = 1"),
        {"model": OLD_MODEL},
    ).scalars().all()

    for channel_id in channel_ids:
        old_row = connection.execute(
            sa.text(
                "SELECT id, sort_order, max_concurrency, chunk_characters, chunk_paragraphs "
                "FROM ai_channel_models WHERE channel_id = :channel_id AND model = :model LIMIT 1"
            ),
            {"channel_id": channel_id, "model": OLD_MODEL},
        ).mappings().first()
        new_id = connection.execute(
            sa.text(
                "SELECT id FROM ai_channel_models "
                "WHERE channel_id = :channel_id AND model = :model LIMIT 1"
            ),
            {"channel_id": channel_id, "model": NEW_MODEL},
        ).scalar()
        if not old_row:
            continue
        if new_id is None:
            connection.execute(
                sa.text(
                    "UPDATE ai_channel_models SET model = :new_model, display_name = :display_name, "
                    "unavailable_until = NULL, unavailable_reason = NULL, updated_at = :now WHERE id = :id"
                ),
                {"id": old_row["id"], "new_model": NEW_MODEL, "display_name": NEW_DISPLAY_NAME, "now": now},
            )
        else:
            connection.execute(
                sa.text(
                    "UPDATE ai_channel_models SET display_name = :display_name, enabled = 1, "
                    "sort_order = :sort_order, max_concurrency = :max_concurrency, "
                    "chunk_characters = :chunk_characters, chunk_paragraphs = :chunk_paragraphs, "
                    "unavailable_until = NULL, unavailable_reason = NULL, updated_at = :now WHERE id = :id"
                ),
                {
                    "id": new_id,
                    "display_name": NEW_DISPLAY_NAME,
                    "sort_order": old_row["sort_order"],
                    "max_concurrency": old_row["max_concurrency"],
                    "chunk_characters": old_row["chunk_characters"],
                    "chunk_paragraphs": old_row["chunk_paragraphs"],
                    "now": now,
                },
            )
            connection.execute(
                sa.text("UPDATE ai_channel_models SET enabled = 0, updated_at = :now WHERE id = :id"),
                {"id": old_row["id"], "now": now},
            )

    connection.execute(
        sa.text(
            "UPDATE users SET ai_translation_model = :new_model, updated_at = :now "
            "WHERE ai_translation_model = :old_model"
        ),
        {"old_model": OLD_MODEL, "new_model": NEW_MODEL, "now": now},
    )
    connection.execute(
        sa.text(
            "UPDATE whole_book_translation_jobs SET model = :new_model, updated_at = :now "
            "WHERE model = :old_model AND status IN ('queued', 'paused', 'waiting_quota', 'failed')"
        ),
        {"old_model": OLD_MODEL, "new_model": NEW_MODEL, "now": now},
    )


def downgrade() -> None:
    # Preserve callable model rows and historical job choices on rollback.
    pass
