"""Projected balance calendar. Rulebook section 6; plan section 7.4.

Combines expected inflows and committed outflows into a running liquid-cash
balance, day by day, and finds the points where it breaches the protected buffer.

The plan is explicit that the useful warning is not "bill due" but "this payment
takes projected cash below your buffer before the next income event", and that
distinction is the whole reason this module computes a *curve* rather than a list.
A list of upcoming bills cannot tell you that the third one is the problem.

This is the planned layer (rulebook section 11). It reads the ledger for an
opening balance and never writes to it. The curve is committed flows only -- it
deliberately assumes zero discretionary spending, which makes it the optimistic
bound, and callers must label it as such rather than presenting it as a forecast
of what will actually happen.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.domain.disposable import account_balances
from app.domain.income import occurrences as income_occurrences
from app.domain.ledger_scope import posted_transaction_ids
from app.domain.money import ZERO
from app.domain.obligation_scope import unmatched
from app.models.enums import LIQUID_KINDS
from app.models.ledger import Account, Posting, Transaction
from app.models.planning import (
    ExpectedIncome,
    FutureObligation,
    ObligationInstance,
    UserProfile,
)

DEFAULT_HORIZON_DAYS = 90

INCOME = "income"
OBLIGATION = "obligation"


@dataclass(frozen=True)
class CalendarEvent:
    kind: str
    name: str
    #: Signed: inflows positive, outflows negative, matching the posting convention.
    amount: Decimal


@dataclass(frozen=True)
class CalendarDay:
    day: date
    events: list[CalendarEvent]
    closing_balance: Decimal
    below_buffer: bool

    @property
    def net(self) -> Decimal:
        return sum((e.amount for e in self.events), ZERO)


@dataclass(frozen=True)
class Calendar:
    start: date
    end: date
    opening_balance: Decimal
    protected_buffer: Decimal
    days: list[CalendarDay] = field(default_factory=list)
    #: The lowest the balance gets, and when.
    trough_date: date | None = None
    trough_balance: Decimal | None = None
    #: The first day the buffer is breached, if any.
    first_breach_date: date | None = None
    #: The event that caused the first breach -- the actionable part of the warning.
    first_breach_cause: str | None = None


def _expected_income_dates(
    session: Session, start: date, end: date
) -> list[tuple[date, str, Decimal]]:
    """Income occurrences strictly after ``start``, up to ``end``.

    Strictly after, for the same reason invariant I1 gives: on payday itself the
    money is already in the ledger, and counting it forward as well would show a
    salary arriving twice.
    """
    return [
        (when, name, amount)
        for when, name, amount in income_occurrences(session, start, end)
        if when > start
    ]


def _committed_outflows(
    session: Session, start: date, end: date
) -> list[tuple[date, str, Decimal]]:
    """Hard obligations due in the window that no payment is linked to.

    A linked instance is excluded (invariant O1) because its transaction is
    already on this curve by one of two routes: a past booking date is inside
    ``account_balances``, which is the opening balance, and a future one is added
    by :func:`_future_posted`. Emitting the obligation as well would subtract the
    same rent twice and invent a buffer breach that is not there.

    Confirmation is not consulted: an unaccepted suggestion is still a link,
    and the money it points at has still left the account.
    """
    rows = session.execute(
        select(
            ObligationInstance.due_date,
            FutureObligation.name,
            ObligationInstance.amount,
        )
        .join(FutureObligation, ObligationInstance.obligation_id == FutureObligation.id)
        .where(unmatched())
        .where(ObligationInstance.due_date >= start)
        .where(ObligationInstance.due_date <= end)
        .where(FutureObligation.hard.is_(True))
        .where(FutureObligation.active.is_(True))
    ).all()
    return [(r.due_date, r.name, r.amount) for r in rows]


def _future_posted(session: Session, start: date, end: date) -> list[tuple[date, str, Decimal]]:
    """Transactions already posted with a future booking date.

    They are real ledger entries, so they belong on the curve, but
    ``account_balances(as_of=today)`` deliberately excludes them -- see the
    future-dated divergence in the cross-engine register. Adding them here keeps
    the curve consistent with the opening balance rather than double-counting.
    """
    out: list[tuple[date, str, Decimal]] = []
    liquid_ids = {
        a.id
        for a in session.scalars(select(Account))
        if a.kind in LIQUID_KINDS
    }
    txns = session.scalars(
        select(Transaction)
        .where(Transaction.status == "POSTED")
        .where(Transaction.booking_date > start)
        .where(Transaction.booking_date <= end)
    ).all()
    for txn in txns:
        movement = sum(
            (p.amount for p in txn.postings if p.account_id in liquid_ids), ZERO
        )
        if movement != ZERO:
            out.append((txn.booking_date, txn.description or "Posted transaction", movement))
    return out


def curve_accounts(session: Session) -> set:
    """The accounts the balance curve is drawn from: active and liquid.

    One selector for the forward curve and the month grid's past days, so the
    day the grid switches from actual to projected cannot show a jump that is
    only two lists of accounts disagreeing.
    """
    return {
        a.id
        for a in session.scalars(select(Account).where(Account.active.is_(True)))
        if a.kind in LIQUID_KINDS
    }


def curve_balance(session: Session, as_of: date) -> Decimal:
    balances = account_balances(session, as_of)
    return sum((balances.get(i, ZERO) for i in curve_accounts(session)), ZERO)


def build(
    session: Session, today: date, horizon: date | None = None
) -> Calendar:
    """The projected liquid-cash curve from today to the horizon."""
    end = horizon or today + timedelta(days=DEFAULT_HORIZON_DAYS)

    opening = curve_balance(session, today)

    profile = session.scalars(select(UserProfile)).first()
    buffer_ = profile.protected_cash_buffer if profile else ZERO

    by_day: dict[date, list[CalendarEvent]] = {}

    def add(when: date, kind: str, name: str, amount: Decimal) -> None:
        by_day.setdefault(when, []).append(CalendarEvent(kind, name, amount))

    for when, name, amount in _expected_income_dates(session, today, end):
        add(when, INCOME, name, amount)
    for when, name, amount in _committed_outflows(session, today, end):
        add(when, OBLIGATION, name, -amount)
    for when, name, movement in _future_posted(session, today, end):
        add(when, OBLIGATION if movement < ZERO else INCOME, name, movement)

    days: list[CalendarDay] = []
    balance = opening
    trough_date, trough_balance = None, None
    first_breach_date, first_breach_cause = None, None

    cursor = today
    while cursor <= end:
        events = by_day.get(cursor, [])
        balance += sum((e.amount for e in events), ZERO)
        below = balance < buffer_

        if trough_balance is None or balance < trough_balance:
            trough_balance, trough_date = balance, cursor

        if below and first_breach_date is None:
            first_breach_date = cursor
            # Name the largest outflow on the breaching day: that is the payment
            # the user can actually do something about.
            outflows = [e for e in events if e.amount < ZERO]
            if outflows:
                first_breach_cause = min(outflows, key=lambda e: e.amount).name

        days.append(
            CalendarDay(
                day=cursor,
                events=events,
                closing_balance=balance,
                below_buffer=below,
            )
        )
        cursor += timedelta(days=1)

    return Calendar(
        start=today,
        end=end,
        opening_balance=opening,
        protected_buffer=buffer_,
        days=days,
        trough_date=trough_date,
        trough_balance=trough_balance,
        first_breach_date=first_breach_date,
        first_breach_cause=first_breach_cause,
    )


# --------------------------------------------------------------------------
# The month grid
# --------------------------------------------------------------------------

ACTUAL = "actual"
TODAY = "today"
PROJECTED = "projected"
#: After the forecast horizon: nothing is claimed about these days.
BEYOND = "beyond"


@dataclass(frozen=True)
class MonthDay:
    day: date
    kind: str
    #: Cash that actually moved, by each transaction's net effect on the curve's
    #: accounts. A transfer between two of them nets to nothing and is neither.
    money_in: Decimal = ZERO
    money_out: Decimal = ZERO
    #: Every posted transaction booked that day, including card purchases that
    #: moved no cash yet (X2) -- the grid should not hide spending that happened.
    transactions: int = 0
    events: list[CalendarEvent] = field(default_factory=list)
    closing_balance: Decimal | None = None
    below_buffer: bool = False


@dataclass(frozen=True)
class MonthView:
    start: date
    end: date
    today: date
    protected_buffer: Decimal
    days: list[MonthDay]


def month(session: Session, first: date, today: date, horizon: date | None = None) -> MonthView:
    """One calendar month: what happened before today, what is committed after.

    Past days read the ledger -- the opening balance from `account_balances`
    and each day's posted movements -- and future days read `build`, the same
    engine the balance curve draws. Nothing is projected for a past day and
    nothing is invented for a day past the forecast horizon.
    """
    first = first.replace(day=1)
    last = (first.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    horizon = horizon or today + timedelta(days=DEFAULT_HORIZON_DAYS)

    profile = session.scalars(select(UserProfile)).first()
    buffer_ = profile.protected_cash_buffer if profile else ZERO

    # Actuals, from the ledger, for every day up to and including today.
    actual_end = min(last, today)
    per_day: dict[date, dict] = {}
    if first <= actual_end:
        accounts = curve_accounts(session)
        rows = session.execute(
            select(
                Transaction.booking_date,
                Transaction.id,
                func.coalesce(
                    func.sum(Posting.amount).filter(Posting.account_id.in_(accounts)), ZERO
                ),
            )
            .join(Posting, Posting.transaction_id == Transaction.id)
            .where(Transaction.id.in_(posted_transaction_ids(start=first, end=actual_end)))
            .group_by(Transaction.booking_date, Transaction.id)
        ).all()
        for when, _txn, net in rows:
            day = per_day.setdefault(when, {"in": ZERO, "out": ZERO, "count": 0})
            day["count"] += 1
            if net > ZERO:
                day["in"] += net
            elif net < ZERO:
                day["out"] += net

    # Forward, from the curve engine itself.
    projected: dict[date, CalendarDay] = {}
    if last >= today and today <= horizon:
        forward = build(session, today, min(last, horizon))
        projected = {d.day: d for d in forward.days}

    days: list[MonthDay] = []
    balance = curve_balance(session, first - timedelta(days=1)) if first <= actual_end else None
    cursor = first
    while cursor <= last:
        moved = per_day.get(cursor, {"in": ZERO, "out": ZERO, "count": 0})
        if cursor < today:
            balance += moved["in"] + moved["out"]
            days.append(
                MonthDay(
                    day=cursor,
                    kind=ACTUAL,
                    money_in=moved["in"],
                    money_out=moved["out"],
                    transactions=moved["count"],
                    closing_balance=balance,
                    below_buffer=balance < buffer_,
                )
            )
        elif cursor in projected:
            ahead = projected[cursor]
            days.append(
                MonthDay(
                    day=cursor,
                    kind=TODAY if cursor == today else PROJECTED,
                    money_in=moved["in"],
                    money_out=moved["out"],
                    transactions=moved["count"],
                    events=ahead.events,
                    closing_balance=ahead.closing_balance,
                    below_buffer=ahead.below_buffer,
                )
            )
        else:
            days.append(MonthDay(day=cursor, kind=BEYOND))
        cursor += timedelta(days=1)

    return MonthView(start=first, end=last, today=today, protected_buffer=buffer_, days=days)

