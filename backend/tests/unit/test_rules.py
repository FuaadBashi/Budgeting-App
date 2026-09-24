"""Categorisation rules: a person's standing instructions for incoming rows."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import get_session
from app.domain import enrichment, importing, rules
from app.main import app
from app.models import CategorisationRule, ImportCandidate, RuleDirection, RuleField, RuleMatch
from tests.conftest import post

STATEMENT = """date,description,amount
2026-08-04,TESCO STORES 3421,-62.40
2026-08-05,AMAZON MKTPLACE PMTS,-19.99
2026-08-06,TFL TRAVEL CH,-2.80
2026-08-07,TFL TRAVEL CH,-45.00
"""


@pytest.fixture
def client(session):
    app.dependency_overrides[get_session] = lambda: session
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def rule(session, pattern, category=None, **fields) -> CategorisationRule:
    made = CategorisationRule(
        name=fields.pop("name", pattern),
        pattern=pattern,
        set_category_id=category.id if category is not None else None,
        field=fields.pop("field", RuleField.EITHER),
        match=fields.pop("match", RuleMatch.CONTAINS),
        direction=fields.pop("direction", RuleDirection.ANY),
        position=fields.pop("position", 0),
        **fields,
    )
    session.add(made)
    session.commit()
    return made


def check(r, description="", merchant=None, amount="-10", account_id=None) -> bool:
    return rules.matches(
        r, description=description, merchant=merchant, amount=Decimal(amount), account_id=account_id
    )


# --------------------------------------------------------------------------
# Matching
# --------------------------------------------------------------------------


def test_contains_ignores_case(session, categories):
    assert check(rule(session, "amazon", categories["groceries"]), "AMAZON MKTPLACE PMTS")


def test_starts_with_does_not_match_in_the_middle(session, categories):
    r = rule(session, "tfl", categories["groceries"], match=RuleMatch.STARTS_WITH)
    assert check(r, "TFL TRAVEL CH")
    assert not check(r, "PAYMENT TO TFL")


def test_equals_ignores_the_reference_numbers_banks_append(session, categories):
    """TESCO STORES 3421 and TESCO STORES 9982 are the same merchant to a person."""
    r = rule(session, "Tesco Stores", categories["groceries"], match=RuleMatch.EQUALS)
    assert check(r, "TESCO STORES 3421")
    assert not check(r, "TESCO STORES EXPRESS")


def test_the_field_condition_is_honoured(session, categories):
    r = rule(session, "blue bottle", categories["groceries"], field=RuleField.MERCHANT)
    assert check(r, description="SQ *CARD 1234", merchant="Blue Bottle")
    assert not check(r, description="BLUE BOTTLE", merchant=None)


def test_amount_bounds_read_the_magnitude(session, categories):
    """A person writes "TfL under £10", not "above -£10"."""
    r = rule(session, "tfl", categories["groceries"], amount_max=Decimal("10"))
    assert check(r, "TFL", amount="-2.80")
    assert not check(r, "TFL", amount="-45.00")


def test_direction_separates_charges_from_refunds(session, categories):
    r = rule(session, "tfl", categories["groceries"], direction=RuleDirection.OUT)
    assert check(r, "TFL", amount="-2.80")
    assert not check(r, "TFL", amount="2.80")


def test_an_account_condition_limits_the_rule_to_rows_on_that_account(session, accounts, categories):
    r = rule(session, "tfl", categories["groceries"], account_id=accounts["current"].id)
    assert check(r, "TFL", account_id=accounts["current"].id)
    assert not check(r, "TFL", account_id=accounts["cash"].id)


def test_the_first_active_rule_in_position_order_wins(session, categories):
    rule(session, "tfl", categories["rent"], position=2, name="late")
    rule(session, "tfl", categories["groceries"], position=1, name="early")
    rule(session, "tfl", categories["food"], position=0, name="off", active=False)
    hit = rules.first_hit(
        rules.active_rules(session), description="TFL", merchant=None,
        amount=Decimal("-1"), account_id=None,
    )
    assert hit.name == "early"


# --------------------------------------------------------------------------
# Staging
# --------------------------------------------------------------------------


def test_a_rule_categorises_and_renames_a_statement_row_as_it_is_staged(
    session, accounts, categories
):
    rule(session, "amazon", categories["groceries"], set_merchant="Amazon", name="Amazon shopping")

    batch = importing.stage(
        session, filename="s.csv", content=STATEMENT, account_id=accounts["current"].id,
        enrich=False,
    )

    row = session.scalars(
        select(ImportCandidate).where(
            ImportCandidate.batch_id == batch.id,
            ImportCandidate.description == "AMAZON MKTPLACE PMTS",
        )
    ).one()
    assert row.suggested_category_id == categories["groceries"].id
    assert row.merchant == "Amazon"
    assert row.raw["rule"] == "Amazon shopping"


def test_a_rule_outranks_the_model_and_saves_asking_it(
    session, accounts, categories, monkeypatch
):
    """A2 applied to patterns: a person's rule stands, and the model is not
    even asked about a row the rule already answered."""
    rule(session, "tesco", categories["groceries"])

    asked: list[list[str]] = []

    class Suggester:
        model = "fake"

        def suggest(self, descriptions, names):
            asked.append(list(descriptions))
            return {d: "Rent" for d in descriptions}

        def verify(self, picks):
            return {}

    monkeypatch.setattr(enrichment, "build_suggester", lambda: Suggester())
    batch = importing.stage(
        session, filename="s.csv", content=STATEMENT, account_id=accounts["current"].id
    )

    tesco = session.scalars(
        select(ImportCandidate).where(
            ImportCandidate.batch_id == batch.id,
            ImportCandidate.description == "TESCO STORES 3421",
        )
    ).one()
    assert tesco.suggested_category_id == categories["groceries"].id
    assert all("TESCO STORES 3421" not in call for call in asked)
    # The rows no rule covered still went to the model.
    assert any("AMAZON MKTPLACE PMTS" in call for call in asked)


def test_an_amount_bounded_rule_splits_one_merchant_by_size(session, accounts, categories):
    rule(session, "tfl", categories["groceries"], amount_max=Decimal("10"))
    batch = importing.stage(
        session, filename="s.csv", content=STATEMENT, account_id=accounts["current"].id,
        enrich=False,
    )
    tfl = {
        c.amount: c.suggested_category_id
        for c in session.scalars(
            select(ImportCandidate).where(
                ImportCandidate.batch_id == batch.id,
                ImportCandidate.description == "TFL TRAVEL CH",
            )
        )
    }
    assert tfl[Decimal("-2.80")] == categories["groceries"].id
    assert tfl[Decimal("-45.00")] is None


def test_a_receipt_is_ruled_like_a_statement_row(session, accounts, categories):
    from tests.unit.test_receipts import FakeReader, a_receipt, stage

    rule(session, "dishoom", categories["restaurants"])
    candidate = stage(session, accounts, FakeReader(a_receipt(merchant="DISHOOM")))
    assert candidate.suggested_category_id == categories["restaurants"].id


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------


def test_a_rule_is_created_last_and_named_from_what_it_does(client, categories):
    first = client.post(
        "/api/rules", json={"pattern": "tesco", "set_category_id": str(categories["groceries"].id)}
    )
    second = client.post("/api/rules", json={"pattern": "sq *blue", "set_merchant": "Blue Bottle"})
    assert first.status_code == 201, first.text
    assert second.json()["position"] > first.json()["position"]
    assert first.json()["name"] == "tesco → Groceries"
    assert second.json()["name"] == "sq *blue → “Blue Bottle”"


@pytest.mark.parametrize(
    "body, reason",
    [
        ({"pattern": "tesco"}, "must set"),
        ({"pattern": "   ", "set_merchant": "X"}, "text to match"),
        ({"pattern": "x", "set_merchant": "X", "amount_min_minor": 500, "amount_max_minor": 100}, "above"),
        ({"pattern": "x", "set_category_id": "00000000-0000-4000-8000-000000000000"}, "unknown category"),
        ({"pattern": "x", "set_merchant": "X", "priority": 1}, None),
    ],
)
def test_a_rule_that_cannot_be_honoured_is_refused(client, body, reason):
    r = client.post("/api/rules", json=body)
    assert r.status_code == 422
    if reason:
        assert reason in r.text


def test_a_rule_cannot_be_limited_to_a_counterparty_account(client, accounts):
    r = client.post(
        "/api/rules",
        json={"pattern": "x", "set_merchant": "X", "account_id": str(accounts["groceries"].id)},
    )
    assert r.status_code == 422
    assert "counterparty" in r.text


def test_an_edit_is_validated_against_the_whole_rule(client, categories):
    """Clearing the only thing a rule sets is valid as a field and invalid as a rule."""
    made = client.post(
        "/api/rules", json={"pattern": "tesco", "set_category_id": str(categories["groceries"].id)}
    ).json()
    r = client.patch(f"/api/rules/{made['id']}", json={"set_category_id": None})
    assert r.status_code == 422
    assert client.get("/api/rules").json()[0]["set_category_id"] == str(categories["groceries"].id)


def test_rules_are_deactivated_never_deleted(client, categories):
    made = client.post("/api/rules", json={"pattern": "tesco", "set_merchant": "Tesco"}).json()
    assert client.delete(f"/api/rules/{made['id']}").status_code == 405
    off = client.patch(f"/api/rules/{made['id']}", json={"active": False})
    assert off.json()["active"] is False


def test_ordering_must_name_every_rule_exactly_once(client):
    a = client.post("/api/rules", json={"pattern": "a", "set_merchant": "A"}).json()
    b = client.post("/api/rules", json={"pattern": "b", "set_merchant": "B"}).json()
    assert client.put("/api/rules/order", json={"rule_ids": [b["id"]]}).status_code == 422
    assert client.put("/api/rules/order", json={"rule_ids": [b["id"], b["id"]]}).status_code == 422
    r = client.put("/api/rules/order", json={"rule_ids": [b["id"], a["id"]]})
    assert [x["id"] for x in r.json()] == [b["id"], a["id"]]
    assert [x["id"] for x in client.get("/api/rules").json()] == [b["id"], a["id"]]


# --------------------------------------------------------------------------
# History
# --------------------------------------------------------------------------


def test_preview_changes_nothing_and_apply_changes_only_what_was_confirmed(
    client, session, accounts, categories
):
    """Rewriting past categories silently would change what closed periods meant,
    so a rule reaches history only through rows a person picked."""
    picked = post(session, date(2026, 8, 4), "TESCO STORES 3421",
                  [(accounts["current"], "-10"), (accounts["groceries"], "10")])
    left = post(session, date(2026, 8, 5), "TESCO STORES 3421",
                [(accounts["current"], "-12"), (accounts["groceries"], "12")])
    made = client.post(
        "/api/rules", json={"pattern": "tesco", "set_category_id": str(categories["groceries"].id)}
    ).json()

    preview = client.get(f"/api/rules/{made['id']}/preview").json()
    assert {p["transaction_id"] for p in preview} == {str(picked.id), str(left.id)}
    assert all(p["changes_category"] for p in preview)
    assert all(p["amount_minor"] < 0 for p in preview)

    r = client.post(f"/api/rules/{made['id']}/apply", json={"transaction_ids": [str(picked.id)]})
    assert r.json() == {"applied": 1}

    session.expire_all()
    categorised = {
        t.id: [p.category_id for p in t.postings if p.account_id == accounts["groceries"].id][0]
        for t in (session.get(type(picked), picked.id), session.get(type(left), left.id))
    }
    assert categorised[picked.id] == categories["groceries"].id
    assert categorised[left.id] is None


def test_applying_to_a_row_the_rule_no_longer_matches_changes_nothing(
    client, session, accounts, categories
):
    match = post(session, date(2026, 8, 4), "TESCO",
                 [(accounts["current"], "-10"), (accounts["groceries"], "10")])
    other = post(session, date(2026, 8, 4), "ALDI",
                 [(accounts["current"], "-10"), (accounts["groceries"], "10")])
    made = client.post(
        "/api/rules", json={"pattern": "tesco", "set_category_id": str(categories["groceries"].id)}
    ).json()

    r = client.post(
        f"/api/rules/{made['id']}/apply",
        json={"transaction_ids": [str(match.id), str(other.id)]},
    )

    assert r.status_code == 422
    session.expire_all()
    assert all(p.category_id is None for p in session.get(type(match), match.id).postings)


def test_a_split_is_reported_rather_than_guessed(client, session, accounts, categories):
    post(session, date(2026, 8, 4), "TESCO",
         [(accounts["current"], "-30"), (accounts["groceries"], "20"), (accounts["interest"], "10")])
    made = client.post(
        "/api/rules", json={"pattern": "tesco", "set_category_id": str(categories["groceries"].id)}
    ).json()
    (row,) = client.get(f"/api/rules/{made['id']}/preview").json()
    assert row["skipped"] == "split across 2 expense legs"
    assert row["changes_category"] is False


def test_a_transfer_is_not_a_match(client, session, accounts, categories):
    """Two real legs: "money out" is true of one side and false of the other."""
    post(session, date(2026, 8, 4), "TESCO SAVINGS",
         [(accounts["current"], "-30"), (accounts["savings"], "30")])
    made = client.post("/api/rules", json={"pattern": "tesco", "set_merchant": "Tesco"}).json()
    assert client.get(f"/api/rules/{made['id']}/preview").json() == []


def test_a_rule_survives_backup_and_restore(client, session, categories):
    from app.domain import backup, restore

    client.post(
        "/api/rules",
        json={"pattern": "tesco", "set_category_id": str(categories["groceries"].id), "amount_max_minor": 5000},
    )
    payload = backup.build_payload(session)
    restore.restore(session, payload, replace=True)

    (back,) = client.get("/api/rules").json()
    assert back["pattern"] == "tesco"
    assert back["amount_max_minor"] == 5000
    assert back["set_category_id"] == str(categories["groceries"].id)
