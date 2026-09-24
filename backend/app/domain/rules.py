"""Categorisation rules: matching rows against a person's standing instructions.

Precedence, highest first: an explicit rule, then a category the person picked
for that exact merchant (the USER row in the merchant cache), then the model's
cached answer, then a fresh model call. Rules sit on top because a person wrote
them deliberately and in general form; the cache only ever learned one merchant
at a time, by example. Nothing a model says can override either (A2).

Rules are deterministic and cheap, so they run synchronously when rows are
staged -- the inbox shows a rule's category on its first render -- and the
optional model enrichment that may follow in the background only fills rows a
rule left uncategorised. A rule hit therefore also saves a model call.

Applying a rule to history is separate and explicit: `preview` lists what would
change and `apply` changes only the transactions a person confirmed. Rewriting
past categories silently would change what closed budget periods meant.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.domain.importing import normalise_description
from app.domain.ledger_scope import posted_transaction_ids
from app.models.enums import NOMINAL_KINDS, AccountKind, RuleDirection, RuleField, RuleMatch
from app.models.ledger import Account, Transaction
from app.models.rules import CategorisationRule

ZERO = Decimal("0")


@dataclass(frozen=True)
class RuleHit:
    rule_id: uuid.UUID
    name: str
    category_id: uuid.UUID | None
    merchant: str | None


def active_rules(session: Session) -> list[CategorisationRule]:
    """In evaluation order. created_at and id break position ties, so two rules
    saved at the same position still run in a fixed order."""
    return list(
        session.scalars(
            select(CategorisationRule)
            .where(CategorisationRule.active.is_(True))
            .order_by(
                CategorisationRule.position,
                CategorisationRule.created_at,
                CategorisationRule.id,
            )
        )
    )


def _text_matches(rule: CategorisationRule, text: str | None) -> bool:
    if not text:
        return False
    if rule.match == RuleMatch.EQUALS:
        wanted = normalise_description(rule.pattern)
        return bool(wanted) and normalise_description(text) == wanted
    haystack = text.casefold()
    needle = rule.pattern.strip().casefold()
    if rule.match == RuleMatch.STARTS_WITH:
        return haystack.startswith(needle)
    return needle in haystack


def matches(
    rule: CategorisationRule,
    *,
    description: str | None,
    merchant: str | None,
    amount: Decimal,
    account_id: uuid.UUID | None,
) -> bool:
    """``amount`` is signed from the account's side: negative is money out."""
    if rule.account_id is not None and rule.account_id != account_id:
        return False
    if rule.direction == RuleDirection.OUT and amount >= ZERO:
        return False
    if rule.direction == RuleDirection.IN and amount <= ZERO:
        return False
    magnitude = abs(amount)
    if rule.amount_min is not None and magnitude < rule.amount_min:
        return False
    if rule.amount_max is not None and magnitude > rule.amount_max:
        return False

    texts = {
        RuleField.DESCRIPTION: (description,),
        RuleField.MERCHANT: (merchant,),
        RuleField.EITHER: (description, merchant),
    }[rule.field]
    return any(_text_matches(rule, t) for t in texts)


def first_hit(
    rules: list[CategorisationRule],
    *,
    description: str | None,
    merchant: str | None,
    amount: Decimal,
    account_id: uuid.UUID | None,
) -> RuleHit | None:
    for rule in rules:
        if matches(
            rule,
            description=description,
            merchant=merchant,
            amount=amount,
            account_id=account_id,
        ):
            return RuleHit(
                rule_id=rule.id,
                name=rule.name,
                category_id=rule.set_category_id,
                merchant=rule.set_merchant,
            )
    return None


def apply_to_candidates(session: Session, candidates, account_id) -> int:
    """Stamp each staged candidate with the first matching rule. Returns hits.

    The rule's name is recorded on the candidate so the inbox can say why a row
    arrived categorised, and so the reason survives the rule later changing.
    """
    rules = active_rules(session)
    if not rules:
        return 0
    hits = 0
    for candidate in candidates:
        hit = first_hit(
            rules,
            description=candidate.description,
            merchant=candidate.merchant,
            amount=candidate.amount,
            account_id=account_id,
        )
        if hit is None:
            continue
        hits += 1
        raw = {**(candidate.raw or {}), "rule": hit.name}
        if hit.category_id is not None:
            candidate.suggested_category_id = hit.category_id
        if hit.merchant:
            candidate.merchant = hit.merchant
            raw["rule_merchant"] = hit.merchant
        candidate.raw = raw
    return hits


# --------------------------------------------------------------------------
# History
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class HistoryMatch:
    transaction: Transaction
    #: The expense leg a category would describe; None when there is not
    #: exactly one, which is why ``skipped`` says so.
    expense_posting_id: uuid.UUID | None
    current_category_id: uuid.UUID | None
    changes_category: bool
    changes_merchant: bool
    skipped: str | None


def money_side(txn: Transaction, kinds: dict) -> tuple[uuid.UUID | None, Decimal]:
    """The real account and signed amount a rule reads, as for a staged row.

    A statement row is one account's view of a payment; a posted transaction
    has two sides. The real (non-nominal) leg is the one a bank would have
    shown, so it is what a rule's amount, direction and account conditions
    mean. Exactly one is required -- a transfer has two, and "money out" is
    true of one side and false of the other.
    """
    real = [p for p in txn.postings if kinds.get(p.account_id) not in NOMINAL_KINDS]
    if len(real) != 1:
        return None, ZERO
    return real[0].account_id, real[0].amount


def preview(session: Session, rule: CategorisationRule, *, limit: int = 500) -> list[HistoryMatch]:
    """Posted transactions this rule matches, most recent first, and what
    applying it would change. Read-only."""
    kinds = {a.id: a.kind for a in session.scalars(select(Account))}
    rows = session.scalars(
        select(Transaction)
        .where(Transaction.id.in_(posted_transaction_ids()))
        .order_by(
            Transaction.booking_date.desc(),
            Transaction.created_at.desc(),
            Transaction.id.desc(),
        )
    )
    found: list[HistoryMatch] = []
    for txn in rows:
        account_id, amount = money_side(txn, kinds)
        if account_id is None:
            continue
        if not matches(
            rule,
            description=txn.description,
            merchant=txn.merchant,
            amount=amount,
            account_id=account_id,
        ):
            continue

        expense = [p for p in txn.postings if kinds.get(p.account_id) == AccountKind.EXPENSE]
        skipped = None
        posting_id = current = None
        changes_category = False
        if rule.set_category_id is not None:
            if len(expense) == 1:
                posting_id = expense[0].id
                current = expense[0].category_id
                changes_category = current != rule.set_category_id
            elif not expense:
                skipped = "no expense leg to categorise"
            else:
                skipped = f"split across {len(expense)} expense legs"
        changes_merchant = bool(rule.set_merchant) and txn.merchant != rule.set_merchant
        found.append(
            HistoryMatch(
                transaction=txn,
                expense_posting_id=posting_id,
                current_category_id=current,
                changes_category=changes_category,
                changes_merchant=changes_merchant,
                skipped=skipped,
            )
        )
        if len(found) >= limit:
            break
    return found


class RuleApplyError(Exception):
    """A requested transaction cannot take this rule. Nothing was written."""


def apply_to_history(
    session: Session, rule: CategorisationRule, transaction_ids: list[uuid.UUID]
) -> int:
    """Apply the rule to exactly these transactions. All or nothing.

    Every id must still be a live match that the rule would change: a preview
    can go stale between showing it and confirming it, and applying a rule to a
    row it no longer matches would be a change nobody saw before approving it.
    """
    wanted = list(dict.fromkeys(transaction_ids))
    if not wanted:
        raise RuleApplyError("no transactions were chosen")
    live = {m.transaction.id: m for m in preview(session, rule, limit=10_000)}

    plan = []
    for txn_id in wanted:
        found = live.get(txn_id)
        if found is None:
            raise RuleApplyError(f"transaction {txn_id} does not match this rule any more")
        if found.skipped and not found.changes_merchant:
            raise RuleApplyError(f"transaction {txn_id} cannot take this rule: {found.skipped}")
        if not (found.changes_category or found.changes_merchant):
            raise RuleApplyError(f"transaction {txn_id} already matches what the rule sets")
        plan.append(found)

    for found in plan:
        txn = found.transaction
        if found.changes_category:
            for posting in txn.postings:
                if posting.id == found.expense_posting_id:
                    posting.category_id = rule.set_category_id
        if found.changes_merchant:
            txn.merchant = rule.set_merchant
        # A category edit writes a posting, not the transaction row, so the
        # row's own onupdate would not fire -- same reason as the edit route.
        txn.updated_at = func.now()
    session.commit()
    return len(plan)
