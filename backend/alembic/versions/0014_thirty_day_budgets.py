"""Explicit anchored 30-day budgets, distinct from calendar months."""

from alembic import op
import sqlalchemy as sa

revision = "0014_thirty_day_budgets"
down_revision = "0013_bank_connections"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint("ck_budget_anchor_iff_fortnightly", "budgets", type_="check")
    op.create_check_constraint(
        "ck_budget_anchor_iff_anchored", "budgets",
        "(period IN ('FORTNIGHTLY', 'THIRTY_DAY')) = (anchor_date IS NOT NULL)",
    )


def downgrade():
    # Refuse to reinterpret a real 30-day plan as a calendar month.
    if op.get_bind().scalar(sa.text("SELECT count(*) FROM budgets WHERE period = 'THIRTY_DAY'")):
        raise RuntimeError("Cannot downgrade while thirty-day budgets exist")
    op.drop_constraint("ck_budget_anchor_iff_anchored", "budgets", type_="check")
    op.create_check_constraint(
        "ck_budget_anchor_iff_fortnightly", "budgets",
        "(period = 'FORTNIGHTLY') = (anchor_date IS NOT NULL)",
    )
