"""Categorisation rules: create, edit, order, and apply to history on request.

No delete route. Rules are deactivated instead: CLAUDE.md allows deletion only
for scenarios and old backups, and a rule's name is recorded on every candidate
it categorised, so the reason a row arrived categorised should stay legible.
"""

from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.schemas import from_minor, to_minor
from app.db import get_session
from app.domain import rules as rules_domain
from app.models import Account, CategorisationRule, Category
from app.models.enums import NOMINAL_KINDS, RuleDirection, RuleField, RuleMatch

router = APIRouter()


class RuleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: Optional: a blank name is built from the pattern and what the rule sets.
    name: str | None = Field(default=None, max_length=120)
    field: RuleField = RuleField.EITHER
    match: RuleMatch = RuleMatch.CONTAINS
    pattern: str = Field(min_length=1, max_length=200)
    amount_min_minor: int | None = Field(default=None, ge=0)
    amount_max_minor: int | None = Field(default=None, ge=0)
    direction: RuleDirection = RuleDirection.ANY
    account_id: uuid.UUID | None = None
    set_category_id: uuid.UUID | None = None
    set_merchant: str | None = Field(default=None, max_length=200)
    active: bool = True


class RuleEditIn(BaseModel):
    """Every field optional; only sent fields change."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=120)
    field: RuleField | None = None
    match: RuleMatch | None = None
    pattern: str | None = Field(default=None, min_length=1, max_length=200)
    amount_min_minor: int | None = Field(default=None, ge=0)
    amount_max_minor: int | None = Field(default=None, ge=0)
    direction: RuleDirection | None = None
    account_id: uuid.UUID | None = None
    set_category_id: uuid.UUID | None = None
    set_merchant: str | None = Field(default=None, max_length=200)
    active: bool | None = None


class RuleOut(BaseModel):
    id: uuid.UUID
    name: str
    position: int
    active: bool
    field: RuleField
    match: RuleMatch
    pattern: str
    amount_min_minor: int | None
    amount_max_minor: int | None
    direction: RuleDirection
    account_id: uuid.UUID | None
    set_category_id: uuid.UUID | None
    set_merchant: str | None


class OrderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rule_ids: list[uuid.UUID]


class PreviewRowOut(BaseModel):
    transaction_id: uuid.UUID
    booking_date: date
    description: str
    merchant: str | None
    #: Signed from the account's side, the same amount the rule reads.
    amount_minor: int
    current_category_id: uuid.UUID | None
    changes_category: bool
    changes_merchant: bool
    #: Why the category part cannot apply, when it cannot.
    skipped: str | None


class ApplyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transaction_ids: list[uuid.UUID] = Field(min_length=1)


class ApplyOut(BaseModel):
    applied: int


def _out(rule: CategorisationRule) -> RuleOut:
    return RuleOut(
        id=rule.id,
        name=rule.name,
        position=rule.position,
        active=rule.active,
        field=rule.field,
        match=rule.match,
        pattern=rule.pattern,
        amount_min_minor=to_minor(rule.amount_min) if rule.amount_min is not None else None,
        amount_max_minor=to_minor(rule.amount_max) if rule.amount_max is not None else None,
        direction=rule.direction,
        account_id=rule.account_id,
        set_category_id=rule.set_category_id,
        set_merchant=rule.set_merchant,
    )


def _get(session: Session, rule_id: uuid.UUID) -> CategorisationRule:
    rule = session.get(CategorisationRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="rule not found")
    return rule


def _validate(session: Session, rule: CategorisationRule) -> None:
    """The whole rule, after any edit is applied, so a PATCH that is valid on
    its own cannot combine with stored values into something the DB refuses."""
    if not rule.pattern.strip():
        raise HTTPException(status_code=422, detail="a rule needs text to match")
    if rule.set_category_id is None and not rule.set_merchant:
        raise HTTPException(
            status_code=422,
            detail="a rule must set a category, a merchant name, or both -- one that sets "
            "nothing would silently shadow every rule after it",
        )
    if (
        rule.amount_min is not None
        and rule.amount_max is not None
        and rule.amount_min > rule.amount_max
    ):
        raise HTTPException(status_code=422, detail="the minimum amount is above the maximum")
    if rule.set_category_id is not None and session.get(Category, rule.set_category_id) is None:
        raise HTTPException(status_code=422, detail=f"unknown category {rule.set_category_id}")
    if rule.account_id is not None:
        account = session.get(Account, rule.account_id)
        if account is None:
            raise HTTPException(status_code=422, detail=f"unknown account {rule.account_id}")
        if account.kind in NOMINAL_KINDS:
            raise HTTPException(
                status_code=422,
                detail=f"{account.name} is a ledger counterparty; rows arrive on the "
                "account the money is held in, so a rule can only be limited to one of those",
            )


def _default_name(session: Session, rule: CategorisationRule) -> str:
    target = []
    if rule.set_category_id is not None:
        category = session.get(Category, rule.set_category_id)
        if category is not None:
            target.append(category.name)
    if rule.set_merchant:
        target.append(f"“{rule.set_merchant}”")
    return f"{rule.pattern.strip()} → {' and '.join(target)}"[:120]


@router.get("/rules", response_model=list[RuleOut])
def list_rules(session: Session = Depends(get_session)) -> list[RuleOut]:
    rows = session.scalars(
        select(CategorisationRule).order_by(
            CategorisationRule.position, CategorisationRule.created_at, CategorisationRule.id
        )
    )
    return [_out(r) for r in rows]


@router.post("/rules", response_model=RuleOut, status_code=201)
def create_rule(payload: RuleIn, session: Session = Depends(get_session)) -> RuleOut:
    last = session.scalar(select(func.max(CategorisationRule.position)))
    rule = CategorisationRule(
        field=payload.field,
        match=payload.match,
        pattern=payload.pattern.strip(),
        amount_min=from_minor(payload.amount_min_minor) if payload.amount_min_minor is not None else None,
        amount_max=from_minor(payload.amount_max_minor) if payload.amount_max_minor is not None else None,
        direction=payload.direction,
        account_id=payload.account_id,
        set_category_id=payload.set_category_id,
        set_merchant=(payload.set_merchant or "").strip() or None,
        active=payload.active,
        # New rules go last: adding one never changes what an existing rule does.
        position=(last + 1) if last is not None else 0,
        name="",
    )
    _validate(session, rule)
    rule.name = (payload.name or "").strip() or _default_name(session, rule)
    session.add(rule)
    session.commit()
    return _out(rule)


@router.patch("/rules/{rule_id}", response_model=RuleOut)
def edit_rule(
    rule_id: uuid.UUID, payload: RuleEditIn, session: Session = Depends(get_session)
) -> RuleOut:
    rule = _get(session, rule_id)
    sent = payload.model_fields_set
    # Edits are applied to the loaded row and then validated as a whole, so a
    # refusal must roll them back: left dirty in the session, the invalid row
    # would be autoflushed by the next query and hit the database CHECK.
    try:
        with session.no_autoflush:
            _apply_edit(session, rule, payload, sent)
    except HTTPException:
        session.rollback()
        raise
    session.commit()
    return _out(rule)


def _apply_edit(session: Session, rule: CategorisationRule, payload: RuleEditIn, sent) -> None:
    for field in ("field", "match", "direction", "active"):
        if field in sent:
            value = getattr(payload, field)
            if value is None:
                raise HTTPException(status_code=422, detail=f"{field} cannot be null")
            setattr(rule, field, value)
    if "pattern" in sent:
        if payload.pattern is None:
            raise HTTPException(status_code=422, detail="pattern cannot be null")
        rule.pattern = payload.pattern.strip()
    if "amount_min_minor" in sent:
        rule.amount_min = from_minor(payload.amount_min_minor) if payload.amount_min_minor is not None else None
    if "amount_max_minor" in sent:
        rule.amount_max = from_minor(payload.amount_max_minor) if payload.amount_max_minor is not None else None
    if "account_id" in sent:
        rule.account_id = payload.account_id
    if "set_category_id" in sent:
        rule.set_category_id = payload.set_category_id
    if "set_merchant" in sent:
        rule.set_merchant = (payload.set_merchant or "").strip() or None
    _validate(session, rule)
    if "name" in sent:
        rule.name = (payload.name or "").strip() or _default_name(session, rule)


@router.put("/rules/order", response_model=list[RuleOut])
def order_rules(payload: OrderIn, session: Session = Depends(get_session)) -> list[RuleOut]:
    """Set every rule's position at once. The list must name each rule exactly
    once: a partial order would leave the omitted rules' positions meaning
    nothing relative to the ones that moved."""
    rules = {r.id: r for r in session.scalars(select(CategorisationRule))}
    if len(payload.rule_ids) != len(set(payload.rule_ids)) or set(payload.rule_ids) != set(rules):
        raise HTTPException(
            status_code=422, detail="rule_ids must list every rule exactly once"
        )
    for position, rule_id in enumerate(payload.rule_ids):
        rules[rule_id].position = position
    session.commit()
    return [_out(rules[i]) for i in payload.rule_ids]


@router.get("/rules/{rule_id}/preview", response_model=list[PreviewRowOut])
def preview_rule(
    rule_id: uuid.UUID, limit: int = 200, session: Session = Depends(get_session)
) -> list[PreviewRowOut]:
    """Past transactions this rule matches and what applying it would change.
    Read-only; nothing here moves a figure."""
    rule = _get(session, rule_id)
    kinds = {a.id: a.kind for a in session.scalars(select(Account))}
    rows = []
    for m in rules_domain.preview(session, rule, limit=min(500, max(1, limit))):
        _account, amount = rules_domain.money_side(m.transaction, kinds)
        rows.append(
            PreviewRowOut(
                transaction_id=m.transaction.id,
                booking_date=m.transaction.booking_date,
                description=m.transaction.description,
                merchant=m.transaction.merchant,
                amount_minor=to_minor(amount),
                current_category_id=m.current_category_id,
                changes_category=m.changes_category,
                changes_merchant=m.changes_merchant,
                skipped=m.skipped,
            )
        )
    return rows


@router.post("/rules/{rule_id}/apply", response_model=ApplyOut)
def apply_rule(
    rule_id: uuid.UUID, payload: ApplyIn, session: Session = Depends(get_session)
) -> ApplyOut:
    """Apply to exactly the transactions a person confirmed from the preview."""
    rule = _get(session, rule_id)
    try:
        applied = rules_domain.apply_to_history(session, rule, payload.transaction_ids)
    except rules_domain.RuleApplyError as exc:
        session.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ApplyOut(applied=applied)
