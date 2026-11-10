"""book_assets composite index for reader lookups

Reader fetches (get_by_index / list_by_book / get_first) filter on
(book_id, asset_type) and order by index. Replace the standalone
book_id / asset_type indexes with one composite index that serves the
filter and the ordering in a single seek.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260619_0014"
down_revision: str | None = "20260526_0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

COMPOSITE_INDEX = "ix_book_assets_book_asset_index"
LEGACY_INDEXES = ("ix_book_assets_book_id", "ix_book_assets_asset_type")


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "book_assets" not in set(inspector.get_table_names()):
        return

    existing = {index["name"] for index in inspector.get_indexes("book_assets")}
    if COMPOSITE_INDEX not in existing:
        op.create_index(COMPOSITE_INDEX, "book_assets", ["book_id", "asset_type", "index"])
    for name in LEGACY_INDEXES:
        if name in existing:
            op.drop_index(name, table_name="book_assets")


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "book_assets" not in set(inspector.get_table_names()):
        return

    existing = {index["name"] for index in inspector.get_indexes("book_assets")}
    if "ix_book_assets_book_id" not in existing:
        op.create_index("ix_book_assets_book_id", "book_assets", ["book_id"])
    if "ix_book_assets_asset_type" not in existing:
        op.create_index("ix_book_assets_asset_type", "book_assets", ["asset_type"])
    if COMPOSITE_INDEX in existing:
        op.drop_index(COMPOSITE_INDEX, table_name="book_assets")
