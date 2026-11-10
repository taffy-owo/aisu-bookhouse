"""add AI translation cache"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260523_0010"
down_revision: str | None = "20260523_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "ai_translation_cache" not in inspector.get_table_names():
        op.create_table(
            "ai_translation_cache",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("user_id", sa.String(length=36), nullable=False),
            sa.Column("book_id", sa.String(length=36), nullable=True),
            sa.Column("chapter_index", sa.Integer(), nullable=True),
            sa.Column("source_hash", sa.String(length=64), nullable=False),
            sa.Column("model", sa.String(length=160), nullable=False),
            sa.Column("target_language", sa.String(length=80), nullable=False),
            sa.Column("translated_text", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_ai_translation_cache_user_id", "ai_translation_cache", ["user_id"])
        op.create_index("ix_ai_translation_cache_book_id", "ai_translation_cache", ["book_id"])
        op.create_index("ix_ai_translation_cache_chapter_index", "ai_translation_cache", ["chapter_index"])
        op.create_index("ix_ai_translation_cache_source_hash", "ai_translation_cache", ["source_hash"])
        op.create_index("ix_ai_translation_cache_model", "ai_translation_cache", ["model"])
        op.create_index("ix_ai_translation_cache_target_language", "ai_translation_cache", ["target_language"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "ai_translation_cache" in inspector.get_table_names():
        op.drop_index("ix_ai_translation_cache_target_language", table_name="ai_translation_cache")
        op.drop_index("ix_ai_translation_cache_model", table_name="ai_translation_cache")
        op.drop_index("ix_ai_translation_cache_source_hash", table_name="ai_translation_cache")
        op.drop_index("ix_ai_translation_cache_chapter_index", table_name="ai_translation_cache")
        op.drop_index("ix_ai_translation_cache_book_id", table_name="ai_translation_cache")
        op.drop_index("ix_ai_translation_cache_user_id", table_name="ai_translation_cache")
        op.drop_table("ai_translation_cache")
