"""add sequential account numbers"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260522_0007"
down_revision: str | None = "20260522_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = [col["name"] for col in inspector.get_columns("users")]
    if "account_number" not in columns:
        op.add_column("users", sa.Column("account_number", sa.Integer(), nullable=True))

    rows = bind.execute(sa.text("SELECT id FROM users ORDER BY created_at ASC, id ASC")).fetchall()
    for account_number, row in enumerate(rows, start=1):
        bind.execute(sa.text("UPDATE users SET account_number = :account_number WHERE id = :id"), {"account_number": account_number, "id": row[0]})

    indexes = [index["name"] for index in inspector.get_indexes("users")]
    if "ix_users_account_number" not in indexes:
        op.create_index("ix_users_account_number", "users", ["account_number"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    indexes = [index["name"] for index in inspector.get_indexes("users")]
    if "ix_users_account_number" in indexes:
        op.drop_index("ix_users_account_number", table_name="users")

    columns = [col["name"] for col in inspector.get_columns("users")]
    if "account_number" in columns:
        with op.batch_alter_table("users") as batch_op:
            batch_op.drop_column("account_number")
