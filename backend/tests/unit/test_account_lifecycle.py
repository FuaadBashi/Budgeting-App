"""Renaming, archiving and restoring accounts.

Archived accounts drop out of safe-to-spend and the forecasts but not net worth,
so the rules here exist to stop money being split between figures: an account
must be empty to archive, and nothing may change an archived account's balance.
"""

from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.db import get_session
from app.domain import importing
from app.main import app
from app.models import ExpectedIncome, ImportBatch, ImportCandidate, SavingsGoal
from app.models.enums import AccountKind
from tests.conftest import make_account, post

DAY = date(2026, 8, 3)


@pytest.fixture
def client(session):
    app.dependency_overrides[get_session] = lambda: session
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def empty(session):
    """A savings pot with nothing in it, the account people retire."""
    account = make_account(session, "Old ISA", AccountKind.SAVINGS)
    session.commit()
    return account


def listed(client, account):
    return next(a for a in client.get("/api/accounts").json() if a["id"] == str(account.id))


def archive(client, account):
    return client.patch(f"/api/accounts/{account.id}", json={"active": False})


# --------------------------------------------------------------------------
# Renaming
# --------------------------------------------------------------------------


def test_renaming_an_account_changes_its_name_and_nothing_else(client, session, accounts):
    session.commit()
    before = listed(client, accounts["current"])

    r = client.patch(f"/api/accounts/{accounts['current'].id}", json={"name": "  Monzo  "})

    assert r.status_code == 200
    after = listed(client, accounts["current"])
    assert after["name"] == "Monzo"
    assert {**after, "name": before["name"]} == before


@pytest.mark.parametrize("body", [{"name": "   "}, {"name": None}, {"name": ""}, {"active": None}])
def test_a_name_or_status_that_cannot_be_stored_is_refused(client, session, accounts, body):
    session.commit()
    assert client.patch(f"/api/accounts/{accounts['current'].id}", json=body).status_code == 422
    assert listed(client, accounts["current"])["name"] == "Current"


def test_an_unknown_field_is_refused_rather_than_ignored(client, session, accounts):
    session.commit()
    r = client.patch(f"/api/accounts/{accounts['current'].id}", json={"nickname": "Monzo"})
    assert r.status_code == 422


# --------------------------------------------------------------------------
# Archiving and restoring
# --------------------------------------------------------------------------


def test_an_empty_account_can_be_archived_and_restored(client, empty):
    assert archive(client, empty).status_code == 200
    assert listed(client, empty)["active"] is False

    assert client.patch(f"/api/accounts/{empty.id}", json={"active": True}).status_code == 200
    assert listed(client, empty)["active"] is True


def test_archiving_an_empty_account_leaves_every_headline_figure_unchanged(
    client, session, accounts, empty
):
    session.commit()
    figures = ("/api/dashboard/safe-to-spend", "/api/dashboard/net-worth")
    before = [client.get(url).json() for url in figures]

    archive(client, empty)

    assert [client.get(url).json() for url in figures] == before


def test_an_account_that_still_holds_money_cannot_be_archived(client, session, accounts):
    session.commit()
    r = archive(client, accounts["current"])

    assert r.status_code == 422
    assert "balance of £1,000.00" in r.json()["detail"]
    assert listed(client, accounts["current"])["active"] is True


def test_an_account_emptied_by_a_transfer_can_then_be_archived(client, session, accounts):
    post(session, DAY, "Close the account", [(accounts["current"], "-1000"),
                                             (accounts["savings"], "1000")])
    assert archive(client, accounts["current"]).status_code == 200


def test_a_future_dated_payment_counts_as_money_still_in_the_account(client, session, accounts, empty):
    post(session, date(2099, 1, 1), "Interest", [(empty, "5"), (accounts["salary"], "-5")])
    r = archive(client, empty)
    assert r.status_code == 422
    assert "£5.00" in r.json()["detail"]


def test_archiving_names_every_reason_at_once(client, session, accounts):
    session.add(SavingsGoal(name="House deposit", target_amount=1000,
                            account_id=accounts["savings"].id))
    session.add(ExpectedIncome(name="Interest", amount=10, first_expected_date=DAY,
                               account_id=accounts["savings"].id))
    session.commit()

    detail = archive(client, accounts["savings"]).json()["detail"]

    assert "balance of £4,500.00" in detail
    assert "House deposit" in detail
    assert "Interest" in detail


def test_a_counterparty_account_can_be_archived_whatever_its_lifetime_total(
    client, session, accounts
):
    post(session, DAY, "Shop", [(accounts["current"], "-40"), (accounts["groceries"], "40")])
    assert archive(client, accounts["groceries"]).status_code == 200


# --------------------------------------------------------------------------
# What an archived account refuses
# --------------------------------------------------------------------------


def test_a_new_transaction_against_an_archived_account_is_refused(client, session, accounts, empty):
    archive(client, empty)
    r = client.post("/api/transactions", json={
        "booking_date": DAY.isoformat(),
        "description": "Top up",
        "postings": [
            {"account_id": str(accounts["current"].id), "amount_minor": -5000},
            {"account_id": str(empty.id), "amount_minor": 5000},
        ],
    })
    assert r.status_code == 422
    assert "Old ISA is archived" in r.json()["detail"]


def test_voiding_a_transaction_on_an_archived_account_is_refused(client, session, accounts):
    # Money in and back out, so the account is empty and can be archived; voiding
    # either leg afterwards would leave it holding money that no screen shows.
    # A current account, because a savings one going negative is refused by G1
    # first and would hide whether this guard works.
    old = make_account(session, "Old Current", AccountKind.CURRENT)
    deposit = post(session, DAY, "In", [(accounts["current"], "-50"), (old, "50")])
    post(session, DAY, "Out", [(old, "-50"), (accounts["current"], "50")])
    archive(client, old)

    r = client.post(f"/api/transactions/{deposit.id}/void")

    assert r.status_code == 422
    assert "Old Current is archived" in r.json()["detail"]
    assert listed(client, old)["balance_minor"] == 0


def test_restoring_an_account_lets_money_move_again(client, session, accounts, empty):
    archive(client, empty)
    client.patch(f"/api/accounts/{empty.id}", json={"active": True})
    r = client.post("/api/transactions", json={
        "booking_date": DAY.isoformat(),
        "postings": [
            {"account_id": str(accounts["current"].id), "amount_minor": -5000},
            {"account_id": str(empty.id), "amount_minor": 5000},
        ],
    })
    assert r.status_code == 201


def test_a_statement_cannot_be_imported_into_an_archived_account(client, session, empty):
    archive(client, empty)
    with pytest.raises(importing.ImportError_, match="archived"):
        importing.importable_account(session, empty.id)


def test_a_row_staged_before_archiving_cannot_be_accepted_after(client, session, accounts, empty):
    batch = ImportBatch(filename="old.csv", content_hash="b" * 64, account_id=empty.id,
                        profile="generic", row_count=1)
    session.add(batch)
    session.flush()
    candidate = ImportCandidate(batch_id=batch.id, row_number=1, raw={}, booking_date=DAY,
                                description="Interest", amount=5, fingerprint="f1")
    session.add(candidate)
    session.commit()
    archive(client, empty)

    with pytest.raises(importing.ImportError_, match="archived"):
        importing.accept(session, candidate, counter_account_id=accounts["salary"].id)


def test_a_goal_cannot_be_pointed_at_an_archived_account(client, session, empty):
    archive(client, empty)
    r = client.post("/api/goals", json={"name": "Holiday", "target_amount_minor": 50000,
                                        "account_id": str(empty.id)})
    assert r.status_code == 422
    assert "archived" in r.json()["detail"]
