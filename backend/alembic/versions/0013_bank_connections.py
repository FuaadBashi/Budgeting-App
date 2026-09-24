"""Bank connections and the accounts linked through them.

Hand-written; autogenerate cannot see the raw-SQL constraints the earlier
migrations installed and proposes dropping them.

Revision ID: 0013_bank_connections
Revises: 0012_categorisation_rules
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0013_bank_connections"
down_revision = "0012_categorisation_rules"
branch_labels = None
depends_on = None


def _stamps():
    return [
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "bank_connections",
        *_stamps(),
        sa.Column("provider", sa.String(length=40), nullable=False),
        sa.Column("aspsp_name", sa.String(length=120), nullable=False),
        sa.Column("aspsp_country", sa.String(length=2), nullable=False),
        sa.Column(
            "status",
            sa.Enum("PENDING", "ACTIVE", "EXPIRED", "REVOKED",
                    name="bank_connection_status", native_enum=False),
            nullable=False,
        ),
        sa.Column("state", sa.String(length=64), nullable=True, unique=True),
        sa.Column("session_id", sa.String(length=120), nullable=True),
        sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        # A connection that claims to be live must have a session to read with.
        sa.CheckConstraint("status <> 'ACTIVE' OR session_id IS NOT NULL",
                           name="ck_bank_active_has_session"),
    )
    op.create_table(
        "bank_links",
        *_stamps(),
        sa.Column("connection_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider_account_id", sa.String(length=120), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("identifier", sa.String(length=40), nullable=True),
        sa.Column("currency", sa.String(length=3), nullable=False, server_default="GBP"),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("synced_through", sa.Date(), nullable=True),
        sa.Column("bank_balance", sa.Numeric(19, 4), nullable=True),
        sa.Column("bank_balance_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["connection_id"], ["bank_connections.id"]),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("connection_id", "provider_account_id", name="uq_bank_link_account"),
    )
    op.create_index("ix_bank_links_connection_id", "bank_links", ["connection_id"])


def downgrade() -> None:
    op.drop_index("ix_bank_links_connection_id", table_name="bank_links")
    op.drop_table("bank_links")
    op.drop_table("bank_connections")
