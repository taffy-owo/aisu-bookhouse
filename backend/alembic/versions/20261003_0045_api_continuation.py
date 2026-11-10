"""Opt-in book permissions and account-scoped idempotency receipts."""
from alembic import op
import sqlalchemy as sa

revision = "20261003_0045"
down_revision = "20261003_0044"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("api_tokens", sa.Column("permissions", sa.JSON(), nullable=False, server_default='["book_import"]'))
    op.add_column("api_tokens", sa.Column("book_id", sa.String(36), nullable=True))
    op.create_table("api_requests",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("response_payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_api_requests_user_id", "api_requests", ["user_id"])


def downgrade() -> None:
    # Older code knows only the import allowlist. Revoke restricted/custom
    # credentials before removing the permissions that constrain them.
    connection = op.get_bind()
    tokens = sa.Table("api_tokens", sa.MetaData(), autoload_with=connection)
    for row in connection.execute(sa.select(tokens.c.id, tokens.c.permissions, tokens.c.book_id)):
        if row.permissions != ["book_import"] or row.book_id is not None:
            connection.execute(tokens.update().where(tokens.c.id == row.id, tokens.c.revoked_at.is_(None))
                .values(revoked_at=sa.func.current_timestamp()))
    op.drop_table("api_requests")
    op.drop_column("api_tokens", "book_id")
    op.drop_column("api_tokens", "permissions")
