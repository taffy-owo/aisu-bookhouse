"""drop AI translation feature tables

The AI translation / AI workbench feature was removed from the product, so its
tables are dropped. Children are dropped before parents. Idempotent: only drops
tables that still exist. Downgrade is a no-op — the feature (and its models) no
longer exist to recreate.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260619_0015"
down_revision: str | None = "20260619_0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Drop order: dependents first, parents last.
DROPPED_TABLES = (
    "translation_chat_messages",
    "translation_export_jobs",
    "translation_job_items",
    "translation_jobs",
    "translation_revisions",
    "translation_operations",
    "translation_terms",
    "translation_paragraphs",
    "translation_chapters",
    "translation_projects",
    "ai_translation_cache",
    "user_ai_settings",
)


def upgrade() -> None:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())
    for table in DROPPED_TABLES:
        if table in existing:
            op.drop_table(table)


def downgrade() -> None:
    # The AI translation feature was removed; its tables are not recreated.
    pass
