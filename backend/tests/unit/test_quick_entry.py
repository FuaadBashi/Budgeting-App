from datetime import date
from decimal import Decimal

import pytest
from fastapi import HTTPException
from app.api.routes import create_transaction, settle_transaction
from app.api.routes import void_transaction
from app.api.schemas import TransactionIn
from app.models import AccountKind
from app.domain.disposable import account_balances
from tests.conftest import make_account


def test_pending_settles_once(session):
    cash = make_account(session, "Cash", AccountKind.CASH, "10")
    expense = make_account(session, "General", AccountKind.EXPENSE)
    p = TransactionIn(booking_date=date(2026, 10, 9), status="candidate", description="NO",
        postings=[dict(account_id=cash.id, amount_minor=-350), dict(account_id=expense.id, amount_minor=350)])
    entry = create_transaction(p, session)
    assert account_balances(session)[cash.id] == Decimal("10")
    settled = settle_transaction(entry.id, date(2026, 10, 10), session)
    assert settled.id == entry.id
    assert account_balances(session)[cash.id] == Decimal("6.50")
    settle_transaction(entry.id, date(2026, 10, 11), session)
    assert account_balances(session)[cash.id] == Decimal("6.50")
    assert settled.booking_date == date(2026, 10, 10)


def test_refund_cannot_exceed_original_including_pending(session):
    cash = make_account(session, "Cash", AccountKind.CASH, "10")
    expense = make_account(session, "General", AccountKind.EXPENSE)
    def payload(amount, **kw):
        return TransactionIn(booking_date=date(2026, 10, 9), description="test", postings=[
            dict(account_id=cash.id, amount_minor=-amount), dict(account_id=expense.id, amount_minor=amount)], **kw)
    purchase = create_transaction(payload(500), session)
    refund = create_transaction(payload(-300, status="candidate", reimburses_id=purchase.id), session)
    with pytest.raises(HTTPException):
        create_transaction(payload(-300, reimburses_id=purchase.id), session)
    session.rollback()
    settle_transaction(refund.id, date(2026,10,9), session)
    assert account_balances(session)[cash.id] == Decimal("8")


def test_voided_pending_cannot_settle(session):
    bank = make_account(session, "Bank", AccountKind.CURRENT)
    family = make_account(session, "Family", AccountKind.INCOME_SOURCE)
    entry = create_transaction(TransactionIn(booking_date=date(2026,10,9), status="candidate",
        description="Gift", postings=[dict(account_id=bank.id, amount_minor=1000),
        dict(account_id=family.id, amount_minor=-1000)]), session)
    void_transaction(entry.id, session)
    with pytest.raises(HTTPException):
        settle_transaction(entry.id, date(2026,10,9), session)
    assert account_balances(session)[bank.id] == 0


def test_pending_income_and_card_transfer(session):
    bank = make_account(session, "Bank", AccountKind.CURRENT)
    card = make_account(session, "Card", AccountKind.LIABILITY)
    entry = create_transaction(TransactionIn(booking_date=date(2026,10,9), status="candidate",
        description="Transfer", postings=[dict(account_id=bank.id, amount_minor=1000),
        dict(account_id=card.id, amount_minor=-1000)]), session)
    assert account_balances(session)[card.id] == 0
    settle_transaction(entry.id, date(2026,10,9), session)
    assert account_balances(session)[bank.id] == 10
    assert account_balances(session)[card.id] == -10
