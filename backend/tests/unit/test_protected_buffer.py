"""The protected cash buffer's route.

The buffer had no route, so it could only be set in the database. These tests
check the route through the figures it moves, not just the column it writes:
a buffer that saved but never reached safe-to-spend would pass a column check.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db import get_session
from app.domain.profile import set_protected_buffer
from app.main import app
from app.models import UserProfile

URL = "/api/protected-buffer"


@pytest.fixture
def client(session):
    app.dependency_overrides[get_session] = lambda: session
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_a_fresh_install_reports_a_zero_buffer(client):
    assert client.get(URL).json() == {"amount_minor": 0}


def test_setting_the_buffer_lowers_safe_to_spend_by_exactly_that_amount(client, session, accounts):
    session.commit()
    before = client.get("/api/dashboard/safe-to-spend").json()

    saved = client.put(URL, json={"amount_minor": 25_000})

    assert saved.status_code == 200
    assert saved.json() == {"amount_minor": 25_000}
    after = client.get("/api/dashboard/safe-to-spend").json()
    assert after["protected_buffer_minor"] == 25_000
    assert before["safe_to_spend_minor"] - after["safe_to_spend_minor"] == 25_000
    assert client.get(URL).json() == {"amount_minor": 25_000}


def test_creating_the_profile_on_a_fresh_install_changes_nothing_but_the_buffer(
    client, session, accounts
):
    # The new row takes the model's column defaults. If those ever drift from
    # the fallbacks the engines use for a missing row, the window or the
    # breakdown moves here even though the buffer stayed at zero.
    session.commit()
    before = client.get("/api/dashboard/safe-to-spend").json()

    client.put(URL, json={"amount_minor": 0})

    assert client.get("/api/dashboard/safe-to-spend").json() == before


def test_the_balance_curve_subtracts_the_same_buffer_as_safe_to_spend(client, session, accounts):
    session.commit()
    client.put(URL, json={"amount_minor": 12_345})

    calendar = client.get("/api/dashboard/calendar").json()
    safe = client.get("/api/dashboard/safe-to-spend").json()
    assert calendar["protected_buffer_minor"] == safe["protected_buffer_minor"] == 12_345


def test_changing_the_buffer_updates_the_one_profile_rather_than_adding_another(client, session):
    client.put(URL, json={"amount_minor": 100})
    client.put(URL, json={"amount_minor": 20_000})

    assert session.scalar(select(func.count()).select_from(UserProfile)) == 1
    assert client.get(URL).json() == {"amount_minor": 20_000}


@pytest.mark.parametrize(
    "body",
    [
        {"amount_minor": -1},  # would add money that does not exist
        {"amount_minor": 10.5},  # a fraction of a penny
        {"amount_minor": 9_007_199_254_740_992},  # past what a browser holds exactly
        {"amount_minor": 100, "currency": "USD"},  # accepted-and-ignored is a bug
        {},
    ],
)
def test_a_buffer_that_cannot_be_honoured_is_refused_and_the_old_one_stands(client, body):
    client.put(URL, json={"amount_minor": 5_000})

    refused = client.put(URL, json=body)

    assert refused.status_code == 422
    assert client.get(URL).json() == {"amount_minor": 5_000}


def test_the_selector_refuses_a_negative_buffer_without_the_route(session):
    with pytest.raises(ValueError):
        set_protected_buffer(session, Decimal("-0.01"))
    assert session.scalar(select(func.count()).select_from(UserProfile)) == 0
