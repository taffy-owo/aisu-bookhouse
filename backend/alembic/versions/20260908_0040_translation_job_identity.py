"""Database-enforced identity for unfinished translation jobs."""
from alembic import op

revision = '20260908_0040'
down_revision = '20260904_0039'
branch_labels = None
depends_on = None


def upgrade():
    from app.modules.translations.idempotency import install_unique_indexes
    install_unique_indexes(op.get_bind())


def downgrade():
    op.drop_index('uq_translation_open_update', table_name='whole_book_translation_jobs')
    op.drop_index('uq_translation_open_work', table_name='whole_book_translation_jobs')
