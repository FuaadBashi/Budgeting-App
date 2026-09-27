from datetime import date

import pytest

from app.api.budget_schemas import BudgetIn
from app.domain.periods import period_for, next_period, prev_period
from app.models.enums import BudgetPeriod


def test_thirty_day_budget_crosses_month_boundary_without_reset():
    anchor = date(2026, 9, 25)
    first = period_for(BudgetPeriod.THIRTY_DAY, anchor, anchor)
    assert (first.start, first.end, first.days) == (anchor, date(2026, 10, 24), 30)
    assert period_for(BudgetPeriod.THIRTY_DAY, date(2026, 10, 1), anchor) == first
    following = next_period(BudgetPeriod.THIRTY_DAY, first, anchor)
    assert following.start == date(2026, 10, 25)
    assert prev_period(BudgetPeriod.THIRTY_DAY, following, anchor) == first
    earlier = period_for(BudgetPeriod.THIRTY_DAY, date(2026, 9, 24), anchor)
    assert earlier.end == date(2026, 9, 24)
    assert earlier.days == 30


def test_thirty_day_budget_requires_an_explicit_anchor():
    with pytest.raises(ValueError, match="anchor_date"):
        BudgetIn(name="Food", period="thirty_day", start_date=date(2026, 9, 25), amount_minor=25000)


@pytest.mark.parametrize("period,anchor", [
    (BudgetPeriod.THIRTY_DAY, None),
    (BudgetPeriod.FORTNIGHTLY, None),
    (BudgetPeriod.MONTHLY, date(2026, 9, 25)),
])
def test_database_rejects_invalid_anchors_independently_of_api(session, period, anchor):
    from sqlalchemy.exc import IntegrityError
    from app.models import Budget

    with pytest.raises(IntegrityError, match="ck_budget_anchor_iff_anchored"):
        with session.begin_nested():
            session.add(Budget(name="Invalid", period=period,
                               start_date=date(2026, 9, 25), anchor_date=anchor))
            session.flush()


def test_thirty_day_budget_can_be_created_through_the_api(session):
    from app.api.budget_routes import create_budget
    payload = BudgetIn(name="Food", period="thirty_day", start_date=date(2026, 9, 25),
                       end_date=date(2026, 10, 24), anchor_date=date(2026, 9, 25), amount_minor=25000)
    result = create_budget(payload, session)
    assert result.period == BudgetPeriod.THIRTY_DAY
    assert result.end_date == date(2026, 10, 24)


def test_spending_on_both_sides_of_month_end_uses_one_allowance(session, accounts, categories):
    from decimal import Decimal
    from app.api.budget_routes import create_budget
    from app.domain.budgets import chain
    from app.models import Budget
    from tests.conftest import post

    result = create_budget(BudgetIn(
        name="Food", period="thirty_day", start_date=date(2026, 9, 25),
        end_date=date(2026, 10, 24), anchor_date=date(2026, 9, 25),
        amount_minor=25000, category_id=categories["groceries"].id,
    ), session)
    for day, amount in [(date(2026, 9, 25), "30"), (date(2026, 10, 2), "20")]:
        post(session, day, "Groceries", [
            (accounts["current"], str(-Decimal(amount))),
            (accounts["groceries"], amount, categories["groceries"]),
        ])
    rows = chain(session, session.get(Budget, result.id), date(2026, 10, 2), date(2026, 10, 2))
    assert len(rows) == 1
    assert rows[0].spent == Decimal("50")
    assert rows[0].remaining == Decimal("200")
    assert rows[0].period_end == date(2026, 10, 24)
