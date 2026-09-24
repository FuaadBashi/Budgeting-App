"""Bank sync: read a bank account's transactions into the candidate inbox.

Four rules, each the same as an existing one:

* **Rows are candidates, never postings (X13).** A synced row lands in the same
  inbox a statement row does and goes through the same duplicate detection and
  rules; nothing reaches the ledger until a person accepts it. A bank's feed is
  more convenient than a CSV, not more trustworthy.
* **Off unless chosen (A3).** ``BANK_SYNC_PROVIDER`` defaults to ``none``: no
  bank is ever contacted, and credentials left in ``.env`` switch nothing on.
* **Idempotent by the bank's own id.** A re-sync overlaps the last one by a week
  (banks back-date late-settling rows), and every row already staged for the
  bank link -- in any status, rejected included -- is skipped, so declining a
  row is a decision that sticks even if the link is remapped later.
* **Only what the ledger can hold.** Pending rows are skipped: they change
  amount or vanish before settling, and a staged pending row would duplicate the
  settled one. Non-GBP rows are skipped too; postings are GBP-only (a CHECK).

The provider is behind a small interface so the whole flow is tested without a
network, which CLAUDE.md requires of every test.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.domain import clock, importing
from app.domain.money import PENCE
from app.models.bank import BankConnection, BankLink
from app.models.enums import BankConnectionStatus
from app.models.imports import ImportBatch, ImportCandidate

log = logging.getLogger("uvicorn.error")

#: UK consents last at most 90 days; a bank may allow less.
CONSENT_DAYS = 90
#: How far back a first sync reaches.
FIRST_SYNC_DAYS = 90
#: Overlap with the previous sync, for rows the bank back-dates.
OVERLAP_DAYS = 7
MAX_PAGES = 50


class BankSyncError(Exception):
    """Something a person can act on. The message is shown as is."""


# --------------------------------------------------------------------------
# What a provider returns
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Bank:
    name: str
    country: str
    logo: str | None = None
    max_consent_days: int | None = None


@dataclass(frozen=True)
class RemoteAccount:
    uid: str
    name: str
    identifier: str | None
    currency: str


@dataclass(frozen=True)
class RemoteSession:
    session_id: str
    accounts: list[RemoteAccount]
    valid_until: datetime | None


@dataclass(frozen=True)
class RemoteTransaction:
    external_id: str | None
    booking_date: date
    #: Signed from the account's side: money out is negative.
    amount: Decimal
    currency: str
    description: str
    counterparty: str | None
    #: "BOOK" (settled) or "PDNG" (pending).
    status: str


@dataclass(frozen=True)
class RemoteBalance:
    amount: Decimal
    currency: str


class BankProvider(Protocol):
    name: str

    def banks(self, country: str) -> list[Bank]: ...
    def start(self, *, bank: str, country: str, state: str, redirect_url: str, valid_until: datetime) -> str: ...
    def session(self, code: str) -> RemoteSession: ...
    def transactions(self, uid: str, date_from: date, date_to: date) -> list[RemoteTransaction]: ...
    def balance(self, uid: str) -> RemoteBalance | None: ...
    def revoke(self, session_id: str) -> None: ...


class NullProvider:
    """No provider chosen. Every call refuses with the reason."""

    name = "none"

    def _off(self, *args, **kwargs):
        raise BankSyncError(
            "Bank sync is off. Set BANK_SYNC_PROVIDER=enable_banking, with an "
            "application id and private key, to turn it on."
        )

    banks = start = session = transactions = balance = revoke = _off


def mask(identifier: str | None) -> str | None:
    """The last four characters, which identify an account to its owner and
    nothing more to anyone else."""
    if not identifier:
        return None
    tail = identifier.replace(" ", "")[-4:]
    return f"…{tail}"


def _money(value) -> Decimal | None:
    """Exact pence or nothing. A value with more than two decimal places
    cannot be a sterling amount, and rounding it would invent money."""
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    if not amount.is_finite() or amount != amount.quantize(PENCE):
        return None
    return amount


# --------------------------------------------------------------------------
# Enable Banking
# --------------------------------------------------------------------------


class EnableBankingProvider:
    """Enable Banking's account-information API.

    Every request carries a JWT signed with the application's private key
    (RS256, ``kid`` = application id). In restricted mode the API returns only
    accounts linked to the application in its control panel, which is what
    makes it free for one person's own accounts.
    """

    name = "enable_banking"
    BASE = "https://api.enablebanking.com"

    def __init__(self, app_id: str, key_path: str, client=None):
        self.app_id = app_id
        self.key_path = key_path
        self._client = client

    def _token(self) -> str:
        try:
            import jwt
        except ImportError as exc:  # pragma: no cover - depends on the install
            raise BankSyncError(
                "Bank sync needs the optional 'bank' extra: pip install -e '.[bank]'"
            ) from exc
        try:
            key = Path(self.key_path).read_text()
        except OSError as exc:
            # The path, not the key, and not the OS error text either.
            raise BankSyncError("The Enable Banking private key could not be read.") from exc
        # Wall-clock, not a reporting date: the token's lifetime is real time.
        now = int(clock.now().timestamp())
        return jwt.encode(
            {"iss": "enablebanking.com", "aud": "api.enablebanking.com", "iat": now, "exp": now + 3600},
            key,
            algorithm="RS256",
            headers={"kid": self.app_id},
        )

    def _request(self, method: str, path: str, **kwargs):
        import httpx

        headers = {"Authorization": f"Bearer {self._token()}"}
        try:
            if self._client is not None:
                response = self._client.request(method, f"{self.BASE}{path}", headers=headers, **kwargs)
            else:
                with httpx.Client(timeout=30) as client:
                    response = client.request(method, f"{self.BASE}{path}", headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            raise BankSyncError(f"Could not reach Enable Banking: {exc.__class__.__name__}") from exc
        if response.status_code >= 400:
            detail = ""
            try:
                body = response.json()
                detail = str(body.get("message") or body.get("detail") or "")[:200]
            except ValueError:
                pass
            raise BankSyncError(f"Enable Banking refused the request ({response.status_code}). {detail}".strip())
        return response.json() if response.content else {}

    def banks(self, country: str) -> list[Bank]:
        body = self._request("GET", "/aspsps", params={"country": country, "psu_type": "personal"})
        out = []
        for row in body.get("aspsps", []):
            seconds = row.get("maximum_consent_validity")
            out.append(
                Bank(
                    name=row.get("name", ""),
                    country=row.get("country", country),
                    logo=row.get("logo"),
                    max_consent_days=int(seconds) // 86400 if isinstance(seconds, int) and seconds > 0 else None,
                )
            )
        return [b for b in out if b.name]

    def start(self, *, bank: str, country: str, state: str, redirect_url: str, valid_until: datetime) -> str:
        body = self._request(
            "POST",
            "/auth",
            json={
                "access": {"valid_until": valid_until.isoformat()},
                "aspsp": {"name": bank, "country": country},
                "state": state,
                "redirect_url": redirect_url,
                "psu_type": "personal",
            },
        )
        url = body.get("url")
        if not url:
            raise BankSyncError("Enable Banking did not return a link to the bank.")
        return url

    def session(self, code: str) -> RemoteSession:
        body = self._request("POST", "/sessions", json={"code": code})
        accounts = []
        for row in body.get("accounts", []):
            ident = row.get("account_id") or {}
            raw_id = ident.get("iban") or (ident.get("other") or {}).get("identification")
            accounts.append(
                RemoteAccount(
                    uid=str(row.get("uid", "")),
                    name=str(row.get("name") or row.get("product") or "Account"),
                    identifier=mask(raw_id),
                    currency=str(row.get("currency") or "GBP"),
                )
            )
        valid = (body.get("access") or {}).get("valid_until")
        try:
            valid_until = datetime.fromisoformat(valid) if valid else None
        except ValueError:
            valid_until = None
        session_id = body.get("session_id")
        if not session_id:
            raise BankSyncError("Enable Banking did not return a session.")
        return RemoteSession(session_id=session_id, accounts=[a for a in accounts if a.uid], valid_until=valid_until)

    def transactions(self, uid: str, date_from: date, date_to: date) -> list[RemoteTransaction]:
        out: list[RemoteTransaction] = []
        key = None
        for _ in range(MAX_PAGES):
            params = {"date_from": date_from.isoformat(), "date_to": date_to.isoformat()}
            if key:
                params["continuation_key"] = key
            body = self._request("GET", f"/accounts/{uid}/transactions", params=params)
            for row in body.get("transactions", []):
                parsed = self._transaction(row)
                if parsed is not None:
                    out.append(parsed)
            key = body.get("continuation_key")
            if not key:
                return out
        raise BankSyncError("The bank returned more pages than expected; try again later.")

    @staticmethod
    def _transaction(row: dict) -> RemoteTransaction | None:
        money = row.get("transaction_amount") or {}
        amount = _money(money.get("amount"))
        when = row.get("booking_date") or row.get("value_date") or row.get("transaction_date")
        if amount is None or not when:
            log.warning("bank row skipped: no usable amount or date")
            return None
        debit = row.get("credit_debit_indicator") == "DBIT"
        party = (row.get("creditor") if debit else row.get("debtor")) or {}
        remittance = row.get("remittance_information") or []
        if isinstance(remittance, str):
            remittance = [remittance]
        counterparty = party.get("name") if isinstance(party, dict) else None
        description = " ".join(str(r) for r in remittance if r).strip() or counterparty or "Bank transaction"
        try:
            booked = date.fromisoformat(str(when)[:10])
        except ValueError:
            return None
        return RemoteTransaction(
            external_id=row.get("transaction_id") or row.get("entry_reference"),
            booking_date=booked,
            amount=-abs(amount) if debit else abs(amount),
            currency=str(money.get("currency") or "GBP"),
            description=description[:240],
            counterparty=counterparty,
            status=str(row.get("status") or "BOOK"),
        )

    def balance(self, uid: str) -> RemoteBalance | None:
        body = self._request("GET", f"/accounts/{uid}/balances")
        rows = body.get("balances") or []
        # Closing booked first: it is the figure a statement would show.
        for wanted in ("CLBD", "ITBD", "XPCD", "ITAV", None):
            for row in rows:
                if wanted is None or row.get("balance_type") == wanted:
                    money = row.get("balance_amount") or {}
                    amount = _money(money.get("amount"))
                    if amount is not None:
                        return RemoteBalance(amount=amount, currency=str(money.get("currency") or "GBP"))
        return None

    def revoke(self, session_id: str) -> None:
        self._request("DELETE", f"/sessions/{session_id}")


def build_provider() -> BankProvider:
    """The only place the provider decision is made. Every setting must be
    present: a provider name alone, with no key, is not a working choice."""
    choice = (settings.bank_sync_provider or "none").strip().lower()
    if choice == "enable_banking" and settings.enable_banking_app_id and settings.enable_banking_key_path:
        return EnableBankingProvider(settings.enable_banking_app_id, settings.enable_banking_key_path)
    return NullProvider()


# --------------------------------------------------------------------------
# The flow
# --------------------------------------------------------------------------


def refresh_status(connection: BankConnection, now: datetime) -> None:
    if (
        connection.status == BankConnectionStatus.ACTIVE
        and connection.valid_until is not None
        and connection.valid_until <= now
    ):
        connection.status = BankConnectionStatus.EXPIRED


def start_connection(
    session: Session, provider: BankProvider, *, bank: str, country: str, redirect_url: str, now: datetime
) -> tuple[BankConnection, str]:
    """Record the request and return the bank's consent page URL."""
    known = {b.name: b for b in provider.banks(country)}
    if bank not in known:
        raise BankSyncError(f"{bank} is not a bank Enable Banking lists for {country}.")
    days = min(CONSENT_DAYS, known[bank].max_consent_days or CONSENT_DAYS)
    state = secrets.token_urlsafe(32)
    connection = BankConnection(
        provider=provider.name,
        aspsp_name=bank,
        aspsp_country=country,
        status=BankConnectionStatus.PENDING,
        state=state,
    )
    url = provider.start(bank=bank, country=country, state=state, redirect_url=redirect_url,
                         valid_until=now + timedelta(days=days))
    session.add(connection)
    session.commit()
    return connection, url


def complete_connection(session: Session, provider: BankProvider, *, code: str, state: str) -> BankConnection:
    """Honour the bank's redirect. The state must match a pending request
    exactly once: a replayed or forged redirect is refused."""
    connection = session.scalars(
        select(BankConnection).where(
            BankConnection.state == state,
            BankConnection.status == BankConnectionStatus.PENDING,
        )
    ).first()
    if connection is None:
        raise BankSyncError("That bank link has already been used or was never started here.")
    remote = provider.session(code)
    connection.session_id = remote.session_id
    connection.valid_until = remote.valid_until
    connection.status = BankConnectionStatus.ACTIVE
    connection.state = None
    existing = {link.provider_account_id for link in connection.links}
    for account in remote.accounts:
        if account.uid in existing:
            continue
        session.add(
            BankLink(
                connection_id=connection.id,
                provider_account_id=account.uid,
                name=account.name,
                identifier=account.identifier,
                currency=account.currency,
            )
        )
    session.commit()
    session.refresh(connection)
    return connection


@dataclass(frozen=True)
class SyncResult:
    staged: int
    already_seen: int
    pending_skipped: int
    foreign_skipped: int
    batch_id: object | None


def _seen_ids(session: Session, link_id, ids: list[str]) -> set[str]:
    if not ids:
        return set()
    external = ImportCandidate.raw["external_id"].astext
    source_link = ImportCandidate.raw["bank_link_id"].astext
    return set(
        session.scalars(
            select(external)
            .where(source_link == str(link_id), external.in_(ids))
        )
    )


def sync_link(
    session: Session,
    provider: BankProvider,
    link: BankLink,
    *,
    today: date,
    now: datetime,
    enrich: bool = True,
) -> SyncResult:
    connection = link.connection
    refresh_status(connection, now)
    if connection.status != BankConnectionStatus.ACTIVE:
        session.commit()
        raise BankSyncError(
            f"The connection to {connection.aspsp_name} is {connection.status.value}. Reconnect to keep syncing."
        )
    if link.account_id is None:
        raise BankSyncError("Choose which account this bank account's rows belong to first.")
    importing.importable_account(session, link.account_id)

    start = (link.synced_through - timedelta(days=OVERLAP_DAYS)) if link.synced_through else today - timedelta(days=FIRST_SYNC_DAYS)
    remote = provider.transactions(link.provider_account_id, start, today)

    booked = [t for t in remote if t.status == "BOOK"]
    pending_skipped = len(remote) - len(booked)
    sterling = [t for t in booked if t.currency == "GBP"]
    foreign_skipped = len(booked) - len(sterling)

    seen = _seen_ids(session, link.id, [t.external_id for t in sterling if t.external_id])
    fresh = [t for t in sterling if not (t.external_id and t.external_id in seen)]

    batch = None
    if fresh:
        rows = [
            importing.ParsedRow(
                row_number=i,
                booking_date=t.booking_date,
                description=t.description,
                merchant=t.counterparty,
                amount=t.amount,
                # Flat primitives only: the inbox renders raw entries as text.
                raw={
                    "source": "bank",
                    "bank": connection.aspsp_name,
                    "bank_link_id": str(link.id),
                    "external_id": t.external_id or "",
                    "counterparty": t.counterparty or "",
                },
            )
            for i, t in enumerate(fresh, start=1)
        ]
        keys = sorted(t.external_id or f"{t.booking_date}|{t.amount}|{t.description}" for t in fresh)
        digest = hashlib.sha256(f"{link.id}|{'|'.join(keys)}".encode()).hexdigest()
        if session.scalar(select(ImportBatch.id).where(ImportBatch.content_hash == digest)) is None:
            batch = importing.stage_rows(
                session,
                filename=f"{connection.aspsp_name} · {link.name} · {today.isoformat()}",
                digest=digest,
                profile_name=f"bank:{provider.name}",
                account_id=link.account_id,
                rows=rows,
                enrich=enrich,
            )
        else:
            fresh = []

    try:
        balance = provider.balance(link.provider_account_id)
    except BankSyncError as exc:
        log.warning("bank balance skipped: %s", exc)
        balance = None
    if balance is not None and balance.currency == "GBP":
        link.bank_balance = balance.amount
        link.bank_balance_at = now

    link.synced_through = today
    link.last_synced_at = now
    session.commit()
    return SyncResult(
        staged=len(fresh),
        already_seen=len(sterling) - len(fresh),
        pending_skipped=pending_skipped,
        foreign_skipped=foreign_skipped,
        batch_id=batch.id if batch is not None else None,
    )


def disconnect(session: Session, provider: BankProvider, connection: BankConnection) -> None:
    """Ask the bank to end the consent, then mark it revoked. The request is
    best effort -- the consent expires on its own -- but the local state is not:
    a disconnected connection never syncs again."""
    if connection.session_id:
        try:
            provider.revoke(connection.session_id)
        except BankSyncError as exc:
            log.warning("bank session revoke failed: %s", exc)
    connection.status = BankConnectionStatus.REVOKED
    connection.state = None
    session.commit()
