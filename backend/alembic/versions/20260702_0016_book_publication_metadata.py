"""Add publication status and source URL to books."""

from alembic import op
import sqlalchemy as sa

revision = "20260702_0016"
down_revision = "20260619_0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    book_columns = {column["name"] for column in inspector.get_columns("books")}
    if "publication_status" not in book_columns:
        op.add_column("books", sa.Column("publication_status", sa.String(length=32), nullable=False, server_default="completed"))
    if "source_url" not in book_columns:
        op.add_column("books", sa.Column("source_url", sa.String(length=1000), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    book_columns = {column["name"] for column in inspector.get_columns("books")}
    if "source_url" in book_columns:
        op.drop_column("books", "source_url")
    if "publication_status" in book_columns:
        op.drop_column("books", "publication_status")
