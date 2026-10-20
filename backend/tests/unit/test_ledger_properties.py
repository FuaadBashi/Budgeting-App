"""The money rules, checked against generated ledgers rather than hand-picked ones.

The example tests in test_ledger_invariants pin the cases someone thought of.
These let Hypothesis build random runs of spending, income, transfers and voids
against the real database (trigger included), and assert the rules hold for all
of them.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from sqlalchemy import func, select

from app.domain.disposable import account_balances, net_worth
from app.models import AccountKind, Posting, TransactionStatus
from tests.conftest import make_account, post

DAY = date(2026, 8, 15)
REAL = ("current", "cash", "savings", "loan")
# Savings only receives: the G1 trigger refuses a savings balance below zero,
# which a random spend or transfer out of it would quickly produce.
SOURCES = ("current", "cash", "loan")

# Pence, never floats: from 1p to £100,000.
pence = st.integers(min_value=1, max_value=10_000_000)

operation = st.one_of(
    st.tuples(st.just("spend"), st.sampled_from(SOURCES), st.just("expense"), pence),
    st.tuples(st.just("income"), st.just("salary"), st.sampled_from(REAL), pence),
    st.tuples(st.just("transfer"), st.sampled_from(SOURCES), st.sampled_from(REAL), pence)
    .filter(lambda op: op[1] != op[2]),
)

# Fixed seed and no example database: the suite must not depend on the run, and
# must not write a .hypothesis directory outside tmp_path.
LEDGER = settings(
    max_examples=40,
    deadline=None,
    derandomize=True,
    database=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)


def _chart(session) -> dict:
    """A fresh chart per example. Examples share one test's session, so earlier
    examples' accounts are still there; each assertion only reads these ones."""
    return {
        "current": make_account(session, "Current", AccountKind.CURRENT, "1000"),
        "cash": make_account(session, "Cash", AccountKind.CASH, "50"),
        "savings": make_account(session, "Savings", AccountKind.SAVINGS, "4500"),
        "loan": make_account(session, "Loan", AccountKind.LIABILITY, "-3000"),
        "salary": make_account(session, "Salary", AccountKind.INCOME_SOURCE),
        "expense": make_account(session, "Spending", AccountKind.EXPENSE),
    }


def _balances(session, chart: dict) -> dict:
    all_balances = account_balances(session)
    return {name: all_balances[a.id] for name, a in chart.items()}


def _apply(session, chart: dict, op: tuple):
    _, source, target, minor = op
    amount = Decimal(minor) / 100
    return post(
        session, DAY, op[0], [(chart[source], str(-amount)), (chart[target], str(amount))]
    )


@LEDGER
@given(ops=st.lists(operation, min_size=1, max_size=12))
def test_every_committed_ledger_sums_to_zero_across_all_postings(session, ops):
    chart = _chart(session)
    for op in ops:
        _apply(session, chart, op)
        assert session.scalar(select(func.sum(Posting.amount))) == 0


@LEDGER
@given(ops=st.lists(operation, min_size=1, max_size=12))
def test_a_transfer_between_real_accounts_never_changes_net_worth(session, ops):
    chart = _chart(session)
    for op in ops:
        before = net_worth(session)
        _apply(session, chart, op)
        after = net_worth(session)
        moved = Decimal(op[3]) / 100
        if op[0] == "transfer":
            assert after == before
        elif op[0] == "spend":
            assert after == before - moved
        else:
            assert after == before + moved


@LEDGER
@given(
    ops=st.lists(operation, min_size=1, max_size=12),
    voids=st.lists(st.booleans(), min_size=12, max_size=12),
)
def test_voiding_restores_every_balance_to_what_the_remaining_ledger_says(
    session, ops, voids
):
    chart = _chart(session)
    opening = _balances(session, chart)
    txns = [_apply(session, chart, op) for op in ops]

    # Void a generated subset, the same way the void route does.
    expected = dict(opening)
    for txn, op, void in zip(txns, ops, voids):
        if void:
            txn.status = TransactionStatus.VOIDED
        else:
            _, source, target, minor = op
            expected[source] -= Decimal(minor) / 100
            expected[target] += Decimal(minor) / 100
    session.commit()
    assert _balances(session, chart) == expected

    # Voiding the rest puts every account back exactly where it started.
    for txn in txns:
        txn.status = TransactionStatus.VOIDED
    session.commit()
    assert _balances(session, chart) == opening
