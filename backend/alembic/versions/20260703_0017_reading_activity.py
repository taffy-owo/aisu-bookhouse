"""Add reading activity table."""

from alembic import op
import sqlalchemy as sa

revision = "20260703_0017"
down_revision = "20260702_0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "reading_activity" in inspector.get_table_names():
        return

    op.create_table(
        "reading_activity",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("book_id", sa.String(), nullable=True),
        sa.Column("date_key", sa.String(length=10), nullable=False),
        sa.Column("seconds", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["book_id"], ["books.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "date_key", "book_id", name="uq_reading_activity_user_date_book"),
    )
    op.create_index(op.f("ix_reading_activity_book_id"), "reading_activity", ["book_id"], unique=False)
    op.create_index(op.f("ix_reading_activity_date_key"), "reading_activity", ["date_key"], unique=False)
    op.create_index(op.f("ix_reading_activity_user_id"), "reading_activity", ["user_id"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "reading_activity" not in inspector.get_table_names():
        return

    op.drop_index(op.f("ix_reading_activity_user_id"), table_name="reading_activity")
    op.drop_index(op.f("ix_reading_activity_date_key"), table_name="reading_activity")
    op.drop_index(op.f("ix_reading_activity_book_id"), table_name="reading_activity")
    op.drop_table("reading_activity")
