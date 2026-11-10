"""ensure invite codes table exists"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260522_0005"
down_revision: str | None = "20260522_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "invite_codes" in inspector.get_table_names():
        return

    op.create_table(
        "invite_codes",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("code", sa.String(length=32), nullable=False),
        sa.Column("inviter_user_id", sa.String(length=36), nullable=False),
        sa.Column("invitee_user_id", sa.String(length=36), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["invitee_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["inviter_user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
    )
    op.create_index(op.f("ix_invite_codes_code"), "invite_codes", ["code"], unique=False)
    op.create_index(op.f("ix_invite_codes_invitee_user_id"), "invite_codes", ["invitee_user_id"], unique=False)
    op.create_index(op.f("ix_invite_codes_inviter_user_id"), "invite_codes", ["inviter_user_id"], unique=False)
    op.create_index(op.f("ix_invite_codes_status"), "invite_codes", ["status"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "invite_codes" not in inspector.get_table_names():
        return

    op.drop_index(op.f("ix_invite_codes_status"), table_name="invite_codes")
    op.drop_index(op.f("ix_invite_codes_inviter_user_id"), table_name="invite_codes")
    op.drop_index(op.f("ix_invite_codes_invitee_user_id"), table_name="invite_codes")
    op.drop_index(op.f("ix_invite_codes_code"), table_name="invite_codes")
    op.drop_table("invite_codes")
