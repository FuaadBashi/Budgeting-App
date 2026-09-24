"""The zero-based month plan, and the expected income it reads."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.db import get_session
from app.domain import analytics, plan
from app.domain.recurrence import Frequency, build_rule
from app.main import app
from app.models import (
    Budget,
    BudgetPeriod,
    BudgetRevision,
    ExpectedIncome,
    FutureObligation,
    ObligationInstance,
    RolloverPolicy,
    SavingsGoal,
)
from tests.conftest import post

SEPTEMBER = date(2026, 9, 1)


@pytest.fixture
def client(session):
    app.dependency_overrides[get_session] = lambda: session
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def budget(session, name, amount, period=BudgetPeriod.MONTHLY, category=None,
           start=date(2026, 1, 1), anchor=None, revisions=()):
    made = Budget(name=name, period=period, start_date=start, anchor_date=anchor,
                  category_id=category.id if category else None)
    session.add(made)
    session.flush()
    for effective, value in ((start, amount), *revisions):
        session.add(BudgetRevision(budget_id=made.id, effective_from=effective,
                                   amount=Decimal(value), rollover_policy=RolloverPolicy.NONE))
    session.commit()
    session.refresh(made)
    return made


def bill(session, name, amount, due, category=None, hard=True):
    ob = FutureObligation(name=name, amount=Decimal(amount), first_due_date=due, hard=hard,
                          category_id=category.id if category else None)
    session.add(ob)
    session.flush()
    session.add(ObligationInstance(obligation_id=ob.id, due_date=due, amount=Decimal(amount)))
    session.commit()
    return ob


def salary(session, amount="2500", day=25):
    anchor = date(2026, 1, day)
    session.add(ExpectedIncome(name="Salary", amount=Decimal(amount), first_expected_date=anchor,
                               rrule=build_rule(Frequency.MONTHLY, anchor), active=True))
    session.commit()


def test_the_terms_add_up_to_what_is_left(session, categories):
    """E1 for the plan: income less every counted line is the unassigned figure,
    with nothing hidden between them."""
    salary(session)
    budget(session, "Food", "400", category=categories["food"])
    bill(session, "Council tax", "150", date(2026, 9, 1))
    session.add(SavingsGoal(name="Holiday", target_amount=Decimal("2000"),
                            planned_contribution=Decimal("200")))
    session.commit()

    p = plan.month_plan(session, SEPTEMBER)

    counted = sum((l.amount for l in p.lines if l.counted and l.kind != plan.INCOME), Decimal("0"))
    assert p.assigned == counted
    assert (p.income_planned, p.bills, p.budgets, p.goals) == (
        Decimal("2500"), Decimal("150"), Decimal("400"), Decimal("200"),
    )
    assert p.unassigned == Decimal("1750")


def test_a_bill_inside_a_budgeted_category_is_counted_once(session, categories):
    """Rent as a commitment and a Rent budget are the same £1,200, not £2,400."""
    budget(session, "Rent", "1200", category=categories["rent"])
    bill(session, "Rent", "1200", date(2026, 9, 1), category=categories["rent"])
    p = plan.month_plan(session, SEPTEMBER)

    assert p.bills == Decimal("0")
    assert p.budgets == Decimal("1200")
    (line,) = [l for l in p.lines if l.kind == plan.BILL]
    assert not line.counted
    assert line.note == "inside the Rent budget"


def test_a_subcategory_of_a_budgeted_category_is_covered_too(session, categories):
    """Scope is the subtree, the same as budget Spent (rulebook section 8)."""
    budget(session, "Food", "400", category=categories["food"])
    bill(session, "Veg box", "30", date(2026, 9, 3), category=categories["groceries"])
    assert plan.month_plan(session, SEPTEMBER).bills == Decimal("0")


def test_an_optional_commitment_is_shown_but_not_assigned(session):
    bill(session, "Gym", "40", date(2026, 9, 5), hard=False)
    p = plan.month_plan(session, SEPTEMBER)
    assert p.bills == Decimal("0")
    assert [l.note for l in p.lines if l.kind == plan.BILL] == ["optional"]


def test_a_weekly_budget_is_pro_rated_by_day_and_rounded_up(session):
    """£10 a week is £42.86 in a 30-day month (30/7 × 10 = 42.857…): not four
    weeks, not five, and rounded towards 'already assigned'."""
    budget(session, "Coffee", "10", period=BudgetPeriod.WEEKLY)
    p = plan.month_plan(session, SEPTEMBER)
    (line,) = [l for l in p.lines if l.kind == plan.BUDGET]
    assert line.amount == Decimal("42.86")
    assert "pro-rated" in line.note


def test_a_revision_mid_month_is_honoured_period_by_period(session):
    """A weekly budget raised from the week of 14 September counts the old
    amount for the weeks before it and the new one after."""
    coffee = budget(session, "Coffee", "7", period=BudgetPeriod.WEEKLY,
                    revisions=[(date(2026, 9, 14), "14")])
    amount, _ = plan.budget_month_amount(coffee, date(2026, 9, 1), date(2026, 9, 30))
    # 1-13 Sep at £1/day (13), 14-30 at £2/day (34).
    assert amount == Decimal("47.00")


def test_a_budget_that_ended_assigns_nothing_after_its_end(session):
    b = budget(session, "Old", "300")
    b.end_date = date(2026, 8, 31)
    session.commit()
    assert plan.month_plan(session, SEPTEMBER).budgets == Decimal("0")


def test_income_received_is_the_analytics_figure(session, accounts):
    """Read from the engine that owns it, not added up again here."""
    post(session, date(2026, 9, 25), "Salary",
         [(accounts["current"], "2400"), (accounts["salary"], "-2400")])
    received = plan.month_plan(session, SEPTEMBER).income_received
    assert received == analytics.summarise(session, date(2026, 9, 1), date(2026, 9, 30)).income
    assert received == Decimal("2400")


def test_the_plan_endpoint_adds_up_in_pence(client, session, categories):
    salary(session, "2500.01")
    budget(session, "Coffee", "10", period=BudgetPeriod.WEEKLY)
    r = client.get("/api/plan/month?month=2026-09").json()
    assert r["assigned_minor"] == r["bills_minor"] + r["budgets_minor"] + r["goals_minor"]
    assert r["unassigned_minor"] == r["income_planned_minor"] - r["assigned_minor"]
    assert client.get("/api/plan/month?month=Sept").status_code == 422


# --------------------------------------------------------------------------
# Expected income
# --------------------------------------------------------------------------


def test_income_is_created_with_a_server_built_rule(client, accounts):
    r = client.post("/api/income", json={
        "name": "Salary", "amount_minor": 250000, "first_expected_date": "2026-01-31",
        "frequency": "monthly", "account_id": str(accounts["current"].id),
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["frequency"] == "monthly"
    listed = client.get("/api/income").json()
    assert [i["name"] for i in listed] == ["Salary"]


def test_income_can_only_land_in_an_account_that_holds_money(client, accounts):
    r = client.post("/api/income", json={
        "name": "Salary", "amount_minor": 100, "first_expected_date": "2026-01-31",
        "account_id": str(accounts["groceries"].id),
    })
    assert r.status_code == 422
    assert "income lands in" in r.text


def test_two_active_incomes_cannot_share_a_name(client):
    body = {"name": "Salary", "amount_minor": 100, "first_expected_date": "2026-01-31"}
    assert client.post("/api/income", json=body).status_code == 201
    assert client.post("/api/income", json=body).status_code == 422


def test_a_refused_income_edit_changes_nothing(client, accounts):
    made = client.post("/api/income", json={
        "name": "Salary", "amount_minor": 100, "first_expected_date": "2026-01-31",
    }).json()
    r = client.patch(f"/api/income/{made['id']}", json={
        "name": "Wages", "account_id": str(accounts["groceries"].id),
    })
    assert r.status_code == 422
    assert client.get("/api/income").json()[0]["name"] == "Salary"


def test_the_schedule_of_an_income_cannot_be_edited(client):
    made = client.post("/api/income", json={
        "name": "Salary", "amount_minor": 100, "first_expected_date": "2026-01-31",
    }).json()
    r = client.patch(f"/api/income/{made['id']}", json={"frequency": "weekly"})
    assert r.status_code == 422


def test_a_deactivated_income_leaves_the_plan(client, session):
    made = client.post("/api/income", json={
        "name": "Salary", "amount_minor": 250000, "first_expected_date": "2026-01-25",
        "frequency": "monthly",
    }).json()
    assert client.get("/api/plan/month?month=2026-09").json()["income_planned_minor"] == 250000
    client.patch(f"/api/income/{made['id']}", json={"active": False})
    assert client.get("/api/plan/month?month=2026-09").json()["income_planned_minor"] == 0
