"""Bank sync. No test here touches the network: the provider is a fake, and the
Enable Banking client is exercised against an in-process mock transport."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db import get_session
from app.domain import bank_sync
from app.main import app
from app.models import (
    BankConnection,
    BankConnectionStatus,
    CandidateStatus,
    CategorisationRule,
    ImportCandidate,
    Transaction,
)
from tests.conftest import post

TODAY = date(2026, 9, 20)
NOW = datetime(2026, 9, 20, 12, tzinfo=timezone.utc)


def txn(ext, when, amount, desc="TESCO STORES", status="BOOK", currency="GBP", party="Tesco"):
    return bank_sync.RemoteTransaction(
        external_id=ext, booking_date=when, amount=Decimal(amount), currency=currency,
        description=desc, counterparty=party, status=status,
    )


class FakeBank:
    name = "fake"

    def __init__(self, rows=None, balance="950.00"):
        self.rows = rows or []
        self.balance_amount = balance
        self.started = []
        self.revoked = []
        self.windows = []

    def banks(self, country):
        return [bank_sync.Bank(name="Monzo", country=country, max_consent_days=90)]

    def start(self, *, bank, country, state, redirect_url, valid_until):
        self.started.append((bank, state, valid_until))
        return f"https://bank.example/consent?state={state}"

    def session(self, code):
        return bank_sync.RemoteSession(
            session_id="sess-1",
            accounts=[bank_sync.RemoteAccount(uid="acc-1", name="Current", identifier="…1234", currency="GBP")],
            valid_until=NOW + timedelta(days=90),
        )

    def transactions(self, uid, date_from, date_to):
        self.windows.append((date_from, date_to))
        return list(self.rows)

    def balance(self, uid):
        return bank_sync.RemoteBalance(Decimal(self.balance_amount), "GBP")

    def revoke(self, session_id):
        self.revoked.append(session_id)


def connected(session, bank, accounts, map_to="current"):
    connection, _url = bank_sync.start_connection(
        session, bank, bank="Monzo", country="GB", redirect_url="http://localhost/cb", now=NOW
    )
    connection = bank_sync.complete_connection(session, bank, code="c0de", state=connection.state)
    link = connection.links[0]
    if map_to:
        link.account_id = accounts[map_to].id
        session.commit()
    return connection, link


def candidates(session):
    return list(session.scalars(select(ImportCandidate).order_by(ImportCandidate.booking_date)))


# --------------------------------------------------------------------------
# Off by default
# --------------------------------------------------------------------------


def test_no_provider_means_no_bank_is_ever_contacted(monkeypatch):
    """A3 applied to banks: a key left in .env switches nothing on."""
    from app.config import settings

    monkeypatch.setattr(settings, "bank_sync_provider", "none")
    monkeypatch.setattr(settings, "enable_banking_app_id", "app")
    monkeypatch.setattr(settings, "enable_banking_key_path", "/tmp/key.pem")
    assert isinstance(bank_sync.build_provider(), bank_sync.NullProvider)


def test_a_provider_name_without_its_credentials_is_still_off(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "bank_sync_provider", "enable_banking")
    monkeypatch.setattr(settings, "enable_banking_app_id", "")
    assert isinstance(bank_sync.build_provider(), bank_sync.NullProvider)


def test_with_sync_off_the_api_says_so(session):
    app.dependency_overrides[get_session] = lambda: session
    try:
        with TestClient(app) as client:
            assert client.get("/api/bank/status").json()["enabled"] is False
            r = client.post("/api/bank/connections", json={"bank": "Monzo"})
            assert r.status_code == 422
            assert "Bank sync is off" in r.text
    finally:
        app.dependency_overrides.clear()


# --------------------------------------------------------------------------
# Consent
# --------------------------------------------------------------------------


def test_a_connection_starts_pending_with_a_one_use_state(session, accounts):
    bank = FakeBank()
    connection, url = bank_sync.start_connection(
        session, bank, bank="Monzo", country="GB", redirect_url="http://localhost/cb", now=NOW
    )
    assert connection.status == BankConnectionStatus.PENDING
    assert connection.state and connection.state in url
    assert bank.started[0][2] == NOW + timedelta(days=90)


def test_an_unknown_bank_is_refused_before_any_consent_is_requested(session):
    bank = FakeBank()
    with pytest.raises(bank_sync.BankSyncError):
        bank_sync.start_connection(session, bank, bank="Nope", country="GB", redirect_url="x", now=NOW)
    assert bank.started == []


def test_the_redirect_activates_the_connection_and_cannot_be_replayed(session, accounts):
    """The state is a one-use CSRF token: a replayed or forged redirect must not
    attach a session to anything."""
    bank = FakeBank()
    connection, _ = bank_sync.start_connection(
        session, bank, bank="Monzo", country="GB", redirect_url="x", now=NOW
    )
    state = connection.state

    done = bank_sync.complete_connection(session, bank, code="c", state=state)
    assert done.status == BankConnectionStatus.ACTIVE
    assert done.state is None
    assert [link.name for link in done.links] == ["Current"]

    with pytest.raises(bank_sync.BankSyncError):
        bank_sync.complete_connection(session, bank, code="c", state=state)


def test_a_forged_state_is_refused(session):
    with pytest.raises(bank_sync.BankSyncError):
        bank_sync.complete_connection(session, FakeBank(), code="c", state="made-up")


# --------------------------------------------------------------------------
# Sync
# --------------------------------------------------------------------------


def test_a_sync_stages_candidates_and_posts_nothing(session, accounts):
    """X13 for a bank feed: a synced row is a candidate until a person accepts it."""
    bank = FakeBank([txn("t1", date(2026, 9, 18), "-12.40"), txn("t2", date(2026, 9, 19), "2500.00", "SALARY", party="Acme")])
    _, link = connected(session, bank, accounts)
    before = session.scalar(select(func.count()).select_from(Transaction))

    result = bank_sync.sync_link(session, bank, link, today=TODAY, now=NOW, enrich=False)

    assert (result.staged, result.already_seen) == (2, 0)
    assert session.scalar(select(func.count()).select_from(Transaction)) == before
    rows = candidates(session)
    assert [r.amount for r in rows] == [Decimal("-12.40"), Decimal("2500.00")]
    assert all(r.status == CandidateStatus.PENDING for r in rows)
    assert rows[0].raw["external_id"] == "t1"


def test_a_resync_does_not_restage_a_row_even_after_it_was_rejected(session, accounts):
    """Declining a row is a decision that sticks."""
    bank = FakeBank([txn("t1", date(2026, 9, 18), "-12.40")])
    _, link = connected(session, bank, accounts)
    bank_sync.sync_link(session, bank, link, today=TODAY, now=NOW, enrich=False)
    (row,) = candidates(session)
    row.status = CandidateStatus.REJECTED
    session.commit()

    again = bank_sync.sync_link(session, bank, link, today=TODAY, now=NOW, enrich=False)

    assert (again.staged, again.already_seen) == (0, 1)
    assert len(candidates(session)) == 1


def test_remapping_a_link_does_not_restage_a_row(session, accounts):
    """The provider account, not its current ledger destination, owns identity."""
    bank = FakeBank([txn("t1", date(2026, 9, 18), "-12.40")])
    _, link = connected(session, bank, accounts)
    bank_sync.sync_link(session, bank, link, today=TODAY, now=NOW, enrich=False)

    link.account_id = accounts["cash"].id
    session.commit()
    again = bank_sync.sync_link(
        session, bank, link, today=TODAY, now=NOW + timedelta(hours=1), enrich=False
    )

    assert (again.staged, again.already_seen) == (0, 1)
    assert len(candidates(session)) == 1


def test_pending_and_foreign_rows_are_skipped_and_counted(session, accounts):
    bank = FakeBank([
        txn("t1", date(2026, 9, 18), "-12.40"),
        txn("t2", date(2026, 9, 19), "-3.00", status="PDNG"),
        txn("t3", date(2026, 9, 19), "-9.00", currency="EUR"),
    ])
    _, link = connected(session, bank, accounts)
    result = bank_sync.sync_link(session, bank, link, today=TODAY, now=NOW, enrich=False)
    assert (result.staged, result.pending_skipped, result.foreign_skipped) == (1, 1, 1)


def test_a_row_already_in_the_ledger_arrives_as_a_duplicate(session, accounts):
    """The same duplicate check a statement row gets."""
    post(session, date(2026, 9, 18), "TESCO STORES",
         [(accounts["current"], "-12.40"), (accounts["groceries"], "12.40")])
    bank = FakeBank([txn("t1", date(2026, 9, 18), "-12.40")])
    _, link = connected(session, bank, accounts)
    bank_sync.sync_link(session, bank, link, today=TODAY, now=NOW, enrich=False)
    (row,) = candidates(session)
    assert row.status == CandidateStatus.DUPLICATE


def test_rules_apply_to_synced_rows(session, accounts, categories):
    session.add(CategorisationRule(name="Tesco", pattern="tesco", set_category_id=categories["groceries"].id))
    session.commit()
    bank = FakeBank([txn("t1", date(2026, 9, 18), "-12.40")])
    _, link = connected(session, bank, accounts)
    bank_sync.sync_link(session, bank, link, today=TODAY, now=NOW, enrich=False)
    (row,) = candidates(session)
    assert row.suggested_category_id == categories["groceries"].id


def test_the_next_sync_overlaps_the_last_by_a_week(session, accounts):
    """Banks back-date rows that settle late; a window starting exactly where
    the last one ended would miss them."""
    bank = FakeBank([])
    _, link = connected(session, bank, accounts)
    bank_sync.sync_link(session, bank, link, today=TODAY, now=NOW, enrich=False)
    bank_sync.sync_link(session, bank, link, today=TODAY + timedelta(days=5), now=NOW, enrich=False)
    assert bank.windows[0] == (TODAY - timedelta(days=90), TODAY)
    assert bank.windows[1] == (TODAY - timedelta(days=7), TODAY + timedelta(days=5))


def test_the_bank_balance_is_recorded_as_the_bank_reported_it(session, accounts):
    bank = FakeBank([], balance="950.00")
    _, link = connected(session, bank, accounts)
    bank_sync.sync_link(session, bank, link, today=TODAY, now=NOW, enrich=False)
    assert link.bank_balance == Decimal("950.00")


def test_an_unmapped_account_is_never_synced(session, accounts):
    bank = FakeBank([txn("t1", date(2026, 9, 18), "-1")])
    _, link = connected(session, bank, accounts, map_to=None)
    with pytest.raises(bank_sync.BankSyncError, match="Choose which account"):
        bank_sync.sync_link(session, bank, link, today=TODAY, now=NOW, enrich=False)
    assert bank.windows == []


def test_an_expired_consent_stops_syncing_and_says_so(session, accounts):
    bank = FakeBank([txn("t1", date(2026, 9, 18), "-1")])
    connection, link = connected(session, bank, accounts)
    later = NOW + timedelta(days=91)
    with pytest.raises(bank_sync.BankSyncError, match="Reconnect"):
        bank_sync.sync_link(session, bank, link, today=TODAY, now=later, enrich=False)
    assert connection.status == BankConnectionStatus.EXPIRED


def test_disconnecting_revokes_and_keeps_the_record(session, accounts):
    bank = FakeBank()
    connection, _ = connected(session, bank, accounts)
    bank_sync.disconnect(session, bank, connection)
    assert bank.revoked == ["sess-1"]
    assert session.get(BankConnection, connection.id).status == BankConnectionStatus.REVOKED


def test_a_link_cannot_map_to_an_account_that_holds_no_money(session, accounts):
    bank = FakeBank()
    _, link = connected(session, bank, accounts, map_to=None)
    app.dependency_overrides[get_session] = lambda: session
    try:
        with TestClient(app) as client:
            r = client.patch(f"/api/bank/links/{link.id}", json={"account_id": str(accounts["groceries"].id)})
            assert r.status_code == 422
    finally:
        app.dependency_overrides.clear()


# --------------------------------------------------------------------------
# The Enable Banking client, against a mock transport
# --------------------------------------------------------------------------


@pytest.fixture
def key_pem(tmp_path):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    path = tmp_path / "key.pem"
    path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return path, key.public_key()


def test_every_request_is_signed_rs256_with_the_application_id(key_pem):
    import httpx
    import jwt

    path, public = key_pem
    seen = {}

    def handler(request):
        seen["auth"] = request.headers["Authorization"]
        return httpx.Response(200, json={"aspsps": []})

    provider = bank_sync.EnableBankingProvider("app-123", str(path), client=httpx.Client(transport=httpx.MockTransport(handler)))
    provider.banks("GB")

    token = seen["auth"].removeprefix("Bearer ")
    assert jwt.get_unverified_header(token)["kid"] == "app-123"
    claims = jwt.decode(token, public, algorithms=["RS256"], audience="api.enablebanking.com")
    assert claims["iss"] == "enablebanking.com"


def test_transactions_are_paged_signed_and_exact(key_pem):
    """Both pages are read; a debit is negative; remittance lines become the
    description; an amount with a fraction of a penny is dropped, not rounded."""
    import httpx

    path, _ = key_pem
    pages = {
        None: {"transactions": [
            {"transaction_id": "a", "booking_date": "2026-09-18", "credit_debit_indicator": "DBIT",
             "transaction_amount": {"currency": "GBP", "amount": "12.40"},
             "remittance_information": ["CARD PAYMENT", "TESCO"], "creditor": {"name": "Tesco"}, "status": "BOOK"},
        ], "continuation_key": "next"},
        "next": {"transactions": [
            {"entry_reference": "b", "booking_date": "2026-09-19", "credit_debit_indicator": "CRDT",
             "transaction_amount": {"currency": "GBP", "amount": "2500.00"}, "debtor": {"name": "Acme"}},
            {"transaction_id": "c", "booking_date": "2026-09-19", "credit_debit_indicator": "DBIT",
             "transaction_amount": {"currency": "GBP", "amount": "1.005"}},
        ]},
    }

    def handler(request):
        return httpx.Response(200, json=pages[request.url.params.get("continuation_key")])

    provider = bank_sync.EnableBankingProvider("app", str(path), client=httpx.Client(transport=httpx.MockTransport(handler)))
    rows = provider.transactions("acc", date(2026, 9, 1), date(2026, 9, 20))

    assert [(r.external_id, r.amount) for r in rows] == [("a", Decimal("-12.40")), ("b", Decimal("2500.00"))]
    assert rows[0].description == "CARD PAYMENT TESCO"
    assert rows[0].counterparty == "Tesco"
    assert rows[1].counterparty == "Acme"


def test_a_session_keeps_only_the_last_four_of_an_account_number(key_pem):
    import httpx

    path, _ = key_pem

    def handler(request):
        assert json.loads(request.content) == {"code": "xyz"}
        return httpx.Response(200, json={
            "session_id": "s1",
            "accounts": [{"uid": "u1", "account_id": {"iban": "GB29 NWBK 6016 1331 9268 19"}, "name": "Current", "currency": "GBP"}],
            "access": {"valid_until": "2026-12-19T12:00:00+00:00"},
        })

    provider = bank_sync.EnableBankingProvider("app", str(path), client=httpx.Client(transport=httpx.MockTransport(handler)))
    remote = provider.session("xyz")
    assert remote.accounts[0].identifier == "…6819"
    assert remote.valid_until == datetime(2026, 12, 19, 12, tzinfo=timezone.utc)


def test_a_refusal_reports_the_status_not_the_credentials(key_pem):
    import httpx

    path, _ = key_pem
    provider = bank_sync.EnableBankingProvider(
        "app", str(path),
        client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(401, json={"message": "bad jwt"}))),
    )
    with pytest.raises(bank_sync.BankSyncError) as caught:
        provider.banks("GB")
    assert "401" in str(caught.value)
    assert "BEGIN PRIVATE KEY" not in str(caught.value)


def test_an_unreadable_key_is_reported_without_its_path_or_contents(tmp_path):
    provider = bank_sync.EnableBankingProvider("app", str(tmp_path / "missing.pem"))
    with pytest.raises(bank_sync.BankSyncError) as caught:
        provider._token()
    assert "missing.pem" not in str(caught.value)
