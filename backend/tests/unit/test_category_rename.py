"""Renaming a category.

A rename relabels history as well as the future: every figure reads a category's
name through its id when it is computed, so last month's breakdown shows the new
name over the same money. A category's nature and parent cannot change, because
either would move spending between budgets in periods already closed.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.db import get_session
from app.main import app
from app.models import Budget, BudgetPeriod, BudgetRevision, RolloverPolicy
from app.models.enums import CategoryNature
from tests.conftest import post

DAY = date(2026, 8, 3)
AUGUST = {"start": "2026-08-01", "end": "2026-08-31"}


@pytest.fixture
def client(session):
    app.dependency_overrides[get_session] = lambda: session
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def shopping(session, accounts, categories):
    """£40 at Tesco filed under Groceries, the category these tests rename."""
    post(session, DAY, "Tesco", [(accounts["current"], "-40"),
                                 (accounts["groceries"], "40", categories["groceries"])])


def rename(client, category, body):
    return client.patch(f"/api/categories/{category.id}", json=body)


def spending_by_category(client) -> dict[str, int]:
    summary = client.get("/api/analytics/period", params=AUGUST).json()
    return {c["name"]: c["amount_minor"] for c in summary["by_category"]}


def numbers(value):
    """Every number in a JSON value, in order: what a rename must leave alone."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return []
    if isinstance(value, (int, float)):
        return [value]
    if isinstance(value, dict):
        return [n for key in sorted(value) for n in numbers(value[key])]
    return [n for item in value for n in numbers(item)]


# --------------------------------------------------------------------------
# What a rename does
# --------------------------------------------------------------------------


def test_renaming_a_category_relabels_its_past_spending_without_moving_any(
    client, categories, shopping
):
    before = spending_by_category(client)

    r = rename(client, categories["groceries"], {"name": "  Food shopping  "})

    assert r.status_code == 200
    assert r.json()["name"] == "Food shopping"
    relabelled = {("Food shopping" if k == "Groceries" else k): v for k, v in before.items()}
    assert spending_by_category(client) == relabelled


def test_renaming_a_category_moves_no_headline_figure_and_no_budget_amount(
    client, session, categories, shopping
):
    budget = Budget(name="Food", period=BudgetPeriod.MONTHLY, start_date=date(2026, 8, 1),
                    category_id=categories["food"].id)
    session.add(budget)
    session.flush()
    session.add(BudgetRevision(budget_id=budget.id, effective_from=date(2026, 8, 1),
                               amount=Decimal(400), rollover_policy=RolloverPolicy.NONE))
    session.commit()
    figures = ("/api/dashboard/safe-to-spend", "/api/dashboard/net-worth",
               f"/api/budgets/{budget.id}/periods")
    before = [numbers(client.get(url).json()) for url in figures]

    rename(client, categories["groceries"], {"name": "Food shopping"})
    rename(client, categories["food"], {"name": "Eating"})

    assert [numbers(client.get(url).json()) for url in figures] == before


def test_a_category_can_change_only_the_case_of_its_own_name(client, categories):
    r = rename(client, categories["groceries"], {"name": "GROCERIES"})
    assert r.status_code == 200
    assert r.json()["name"] == "GROCERIES"


def test_the_same_name_under_another_parent_is_allowed(client, categories):
    # Rent sits at the top level; Groceries sits under Food.
    assert rename(client, categories["rent"], {"name": "Groceries"}).status_code == 200


# --------------------------------------------------------------------------
# What a rename refuses
# --------------------------------------------------------------------------


def test_a_name_a_sibling_already_has_is_refused_whatever_its_case(client, session, categories):
    r = rename(client, categories["restaurants"], {"name": "groceries"})

    assert r.status_code == 422
    assert "already a category called 'Groceries'" in r.json()["detail"]
    session.refresh(categories["restaurants"])
    assert categories["restaurants"].name == "Restaurants"


@pytest.mark.parametrize("body", [{"name": "   "}, {"name": ""}, {"name": None}, {}])
def test_a_name_that_cannot_be_stored_is_refused(client, categories, body):
    assert rename(client, categories["groceries"], body).status_code == 422


def test_its_nature_cannot_change_because_closed_months_would_change(client, session, categories):
    r = rename(client, categories["groceries"], {"name": "Groceries", "nature": "essential"})

    assert r.status_code == 422
    assert "nature cannot be changed" in str(r.json()["detail"])
    session.refresh(categories["groceries"])
    assert categories["groceries"].nature == CategoryNature.DISCRETIONARY


def test_it_cannot_be_moved_under_another_parent(client, session, categories):
    r = rename(client, categories["groceries"],
               {"name": "Groceries", "parent_id": str(categories["rent"].id)})

    assert r.status_code == 422
    assert "another parent" in str(r.json()["detail"])
    session.refresh(categories["groceries"])
    assert categories["groceries"].parent_id == categories["food"].id


def test_an_unknown_field_is_refused_rather_than_ignored(client, session, categories):
    r = rename(client, categories["groceries"], {"name": "Food shopping", "colour": "green"})

    assert r.status_code == 422
    session.refresh(categories["groceries"])
    assert categories["groceries"].name == "Groceries"


def test_renaming_a_category_that_does_not_exist_is_not_found(client):
    assert client.patch(f"/api/categories/{uuid.uuid4()}", json={"name": "Anything"}).status_code == 404
