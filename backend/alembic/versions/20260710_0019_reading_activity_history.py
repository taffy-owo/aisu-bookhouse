"""Preserve reading history and add idempotent activity events."""

from alembic import op
import sqlalchemy as sa


revision = "20260710_0019"
down_revision = "20260704_0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "reading_activity" in table_names:
        column_names = {column["name"] for column in inspector.get_columns("reading_activity")}
        if "book_title" not in column_names:
            op.add_column("reading_activity", sa.Column("book_title", sa.String(length=255), nullable=True))
            op.execute(
                "UPDATE reading_activity SET book_title = "
                "(SELECT books.title FROM books WHERE books.id = reading_activity.book_id) "
                "WHERE book_id IS NOT NULL"
            )

    if "reading_activity_events" not in table_names:
        op.create_table(
            "reading_activity_events",
            sa.Column("id", sa.String(length=64), nullable=False),
            sa.Column("user_id", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(op.f("ix_reading_activity_events_user_id"), "reading_activity_events", ["user_id"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "reading_activity_events" in table_names:
        op.drop_index(op.f("ix_reading_activity_events_user_id"), table_name="reading_activity_events")
        op.drop_table("reading_activity_events")

    if "reading_activity" in table_names:
        column_names = {column["name"] for column in inspector.get_columns("reading_activity")}
        if "book_title" in column_names:
            op.drop_column("reading_activity", "book_title")
