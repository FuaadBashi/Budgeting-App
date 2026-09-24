"""Categorisation rules: a person's standing instructions for incoming rows.

Hand-written; autogenerate cannot see the raw-SQL constraints the earlier
migrations installed and proposes dropping them.

Revision ID: 0012_categorisation_rules
Revises: 0011_obligation_match_reversal
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0012_categorisation_rules"
down_revision = "0011_obligation_match_reversal"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "categorisation_rules",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column(
            "field",
            sa.Enum("DESCRIPTION", "MERCHANT", "EITHER", name="rule_field", native_enum=False),
            nullable=False,
        ),
        sa.Column(
            "match",
            sa.Enum("CONTAINS", "STARTS_WITH", "EQUALS", name="rule_match", native_enum=False),
            nullable=False,
        ),
        sa.Column("pattern", sa.String(length=200), nullable=False),
        sa.Column("amount_min", sa.Numeric(19, 4), nullable=True),
        sa.Column("amount_max", sa.Numeric(19, 4), nullable=True),
        sa.Column(
            "direction",
            sa.Enum("ANY", "OUT", "IN", name="rule_direction", native_enum=False),
            nullable=False,
        ),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("set_category_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("set_merchant", sa.String(length=200), nullable=True),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["set_category_id"], ["categories.id"]),
        sa.PrimaryKeyConstraint("id"),
        # A rule that sets nothing matches rows and changes nothing, silently
        # shadowing every rule after it.
        sa.CheckConstraint(
            "set_category_id IS NOT NULL OR set_merchant IS NOT NULL",
            name="ck_rule_sets_something",
        ),
        sa.CheckConstraint("length(btrim(pattern)) > 0", name="ck_rule_pattern_not_blank"),
        sa.CheckConstraint(
            "amount_min IS NULL OR amount_max IS NULL OR amount_min <= amount_max",
            name="ck_rule_amount_range",
        ),
    )
    op.create_index("ix_categorisation_rules_position", "categorisation_rules", ["position"])


def downgrade() -> None:
    op.drop_index("ix_categorisation_rules_position", table_name="categorisation_rules")
    op.drop_table("categorisation_rules")
