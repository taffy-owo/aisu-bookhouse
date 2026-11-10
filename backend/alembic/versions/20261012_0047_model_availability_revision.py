"""Fence model availability changes made by concurrent translation tasks."""
from alembic import op
import sqlalchemy as sa

revision = "20261012_0047"
down_revision = "20261003_0046"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Local SQLite startup compatibility may already have added this field.
    columns = {column['name'] for column in sa.inspect(op.get_bind()).get_columns('ai_channel_models')}
    if 'availability_revision' not in columns:
        op.add_column('ai_channel_models', sa.Column('availability_revision', sa.Integer(), nullable=False, server_default='0'))


def downgrade() -> None:
    op.drop_column('ai_channel_models', 'availability_revision')
