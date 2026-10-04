"""Archiving an account: what it requires, and what an archived account refuses.

Safe-to-spend, the balance curve, budget recovery, the simulator and the debt
planner read active accounts only, while net worth reads every account. So an
account that still holds money cannot be archived: its balance would leave some
figures and stay in others. For the same reason nothing may change an archived
account's balance afterwards -- a new posting, an accepted import row or a void
would give it money no screen shows. Restoring the account is the way back in.

Counterparty accounts (expense, income source) hold nothing, so their lifetime
totals never block archiving, and their past postings keep counting: Spent
reads postings, not account status.
"""

from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.disposable import account_balances
from app.domain.money import ZERO
from app.models.bank import BankConnection, BankLink
from app.models.enums import NOMINAL_KINDS, BankConnectionStatus
from app.models.ledger import Account
from app.models.planning import ExpectedIncome, FutureObligation, SavingsGoal


class ArchivedAccountError(ValueError):
    """Money was about to move in or out of an archived account."""


def archive_blockers(session: Session, account: Account) -> list[str]:
    """Why ``account`` cannot be archived yet; empty when it can.

    Every reason is returned at once, so the person fixes them in one pass
    rather than discovering them one refusal at a time.
    """
    reasons: list[str] = []

    if account.kind not in NOMINAL_KINDS:
        # No date cutoff: a future-dated payment still leaves money behind.
        balance: Decimal = account_balances(session).get(account.id, ZERO)
        if balance != ZERO:
            reasons.append(
                f"it still has a balance of £{balance:,.2f}; move it to zero first"
            )

    goals = session.scalars(
        select(SavingsGoal.name).where(
            SavingsGoal.account_id == account.id, SavingsGoal.active.is_(True)
        )
    ).all()
    if goals:
        reasons.append(f"goals still save into it: {', '.join(sorted(goals))}")

    bills = session.scalars(
        select(FutureObligation.name).where(
            FutureObligation.account_id == account.id, FutureObligation.active.is_(True)
        )
    ).all()
    if bills:
        reasons.append(f"commitments are still paid from it: {', '.join(sorted(bills))}")

    income = session.scalars(
        select(ExpectedIncome.name).where(
            ExpectedIncome.account_id == account.id, ExpectedIncome.active.is_(True)
        )
    ).all()
    if income:
        reasons.append(f"expected income still lands in it: {', '.join(sorted(income))}")

    feeds = session.scalar(
        select(BankLink.id)
        .join(BankConnection, BankLink.connection_id == BankConnection.id)
        .where(
            BankLink.account_id == account.id,
            BankConnection.status != BankConnectionStatus.REVOKED,
        )
        .limit(1)
    )
    if feeds is not None:
        reasons.append("a bank feed is mapped to it; unmap or revoke it first")

    return reasons


def ensure_open(session: Session, account_ids: Iterable, action: str) -> None:
    """Refuse ``action`` if any of ``account_ids`` is archived."""
    ids = set(account_ids)
    if not ids:
        return
    closed = session.scalars(
        select(Account.name).where(Account.id.in_(ids), Account.active.is_(False))
    ).all()
    if closed:
        names = ", ".join(sorted(closed))
        raise ArchivedAccountError(
            f"{names} {'is' if len(closed) == 1 else 'are'} archived; "
            f"restore it on the Accounts screen before {action}"
        )
