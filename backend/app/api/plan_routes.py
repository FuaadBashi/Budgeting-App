"""The zero-based month plan, and the expected income it is built on.

Expected income had a model and an engine -- it sets safe-to-spend's window to
the next payday -- but no route, so it could only be set by the seed script.
A plan whose income cannot be entered is a plan of nothing.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import from_minor, to_minor
from app.db import get_session
from app.domain import plan as plan_domain
from app.domain.clock import today as clock_today
from app.domain.income import occurrences
from app.domain.recurrence import Frequency, build_rule, frequency_of
from app.models import Account, ExpectedIncome
from app.models.enums import AccountKind

router = APIRouter()

#: Where income can land: the kinds the Add form offers for income.
RECEIVING_KINDS = {AccountKind.CURRENT, AccountKind.CASH, AccountKind.SAVINGS, AccountKind.INVESTMENT}


# --------------------------------------------------------------------------
# Expected income
# --------------------------------------------------------------------------


class IncomeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    amount_minor: int = Field(gt=0)
    first_expected_date: date
    #: Omit for a one-off payment.
    frequency: Frequency | None = None
    account_id: uuid.UUID | None = None


class IncomeUpdate(BaseModel):
    """What can change without moving past or future dates. The rule and its
    anchor are absent on purpose: a different schedule is a different income."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    amount_minor: int | None = Field(default=None, gt=0)
    account_id: uuid.UUID | None = None
    active: bool | None = None


class IncomeOut(BaseModel):
    id: uuid.UUID
    name: str
    amount_minor: int
    first_expected_date: date
    frequency: Frequency | None
    #: The next occurrence on or after today, derived from the rule.
    next_date: date | None
    account_id: uuid.UUID | None
    active: bool


def _next(session: Session, income: ExpectedIncome, today: date) -> date | None:
    if not income.active:
        return None
    for when, name, _amount in occurrences(session, today, today + timedelta(days=400)):
        if name == income.name:
            return when
    return None


def _income_out(session: Session, income: ExpectedIncome) -> IncomeOut:
    try:
        frequency = frequency_of(income.rrule)
    except ValueError:
        frequency = None
    return IncomeOut(
        id=income.id,
        name=income.name,
        amount_minor=to_minor(income.amount),
        first_expected_date=income.first_expected_date,
        frequency=frequency,
        next_date=_next(session, income, clock_today(session)),
        account_id=income.account_id,
        active=income.active,
    )


def _check_account(session: Session, account_id: uuid.UUID | None) -> None:
    if account_id is None:
        return
    account = session.get(Account, account_id)
    if account is None:
        raise HTTPException(status_code=422, detail=f"unknown account {account_id}")
    if account.kind not in RECEIVING_KINDS:
        raise HTTPException(
            status_code=422,
            detail=f"{account.name} is a {account.kind.value} account; income lands in a "
            "current, cash, savings or investment account",
        )


def _check_name_free(session: Session, name: str, exclude: uuid.UUID | None = None) -> None:
    # Occurrences are matched back to their income by name (see _next), and two
    # active incomes called "Salary" would also be indistinguishable on the plan.
    conditions = [ExpectedIncome.active.is_(True), ExpectedIncome.name == name]
    if exclude is not None:
        conditions.append(ExpectedIncome.id != exclude)
    clash = session.scalar(select(ExpectedIncome).where(*conditions))
    if clash is not None:
        raise HTTPException(status_code=422, detail=f"there is already an income called {name!r}")


@router.get("/income", response_model=list[IncomeOut])
def list_income(session: Session = Depends(get_session)) -> list[IncomeOut]:
    rows = session.scalars(select(ExpectedIncome).order_by(ExpectedIncome.name, ExpectedIncome.id))
    return [_income_out(session, i) for i in rows]


@router.post("/income", response_model=IncomeOut, status_code=201)
def create_income(payload: IncomeIn, session: Session = Depends(get_session)) -> IncomeOut:
    name = payload.name.strip()
    _check_account(session, payload.account_id)
    _check_name_free(session, name)
    income = ExpectedIncome(
        name=name,
        amount=from_minor(payload.amount_minor),
        first_expected_date=payload.first_expected_date,
        # Built here, as for obligations, so month-end clamping is consistent.
        rrule=build_rule(payload.frequency, payload.first_expected_date) if payload.frequency else None,
        account_id=payload.account_id,
        active=True,
    )
    session.add(income)
    session.commit()
    return _income_out(session, income)


@router.patch("/income/{income_id}", response_model=IncomeOut)
def edit_income(
    income_id: uuid.UUID, payload: IncomeUpdate, session: Session = Depends(get_session)
) -> IncomeOut:
    income = session.get(ExpectedIncome, income_id)
    if income is None:
        raise HTTPException(status_code=404, detail="income not found")
    sent = payload.model_fields_set
    # Every check before any write: a refusal must leave the income exactly as
    # it was, not with the fields that happened to come first already changed.
    for field in ("name", "amount_minor", "active"):
        if field in sent and getattr(payload, field) is None:
            raise HTTPException(status_code=422, detail=f"{field} cannot be null")
    if "name" in sent:
        _check_name_free(session, payload.name.strip(), exclude=income.id)
    if "account_id" in sent:
        _check_account(session, payload.account_id)

    if "name" in sent:
        income.name = payload.name.strip()
    if "amount_minor" in sent:
        income.amount = from_minor(payload.amount_minor)
    if "account_id" in sent:
        income.account_id = payload.account_id
    if "active" in sent:
        income.active = payload.active
    session.commit()
    return _income_out(session, income)


# --------------------------------------------------------------------------
# The month plan
# --------------------------------------------------------------------------


class PlanLineOut(BaseModel):
    kind: str
    id: uuid.UUID | None
    name: str
    amount_minor: int
    counted: bool
    note: str
    when: date | None
    edit_amount_minor: int | None
    period: str | None


class MonthPlanOut(BaseModel):
    start: date
    end: date
    today: date
    #: False for a month already over: the plan for it is history, and a budget
    #: edit applies from the current period, so it could not change that month.
    editable: bool
    income_planned_minor: int
    income_received_minor: int
    bills_minor: int
    budgets_minor: int
    goals_minor: int
    assigned_minor: int
    #: income_planned - assigned. Zero is a balanced plan; negative is more
    #: assigned than expected to arrive.
    unassigned_minor: int
    lines: list[PlanLineOut]


@router.get("/plan/month", response_model=MonthPlanOut)
def month_plan(month: str | None = None, session: Session = Depends(get_session)) -> MonthPlanOut:
    """``month`` is YYYY-MM; this month when omitted."""
    if month is None:
        first = clock_today(session).replace(day=1)
    else:
        try:
            year, number = (int(part) for part in month.split("-"))
            first = date(year, number, 1)
        except (ValueError, TypeError):
            raise HTTPException(status_code=422, detail=f"month must look like 2026-09, not {month!r}")
    p = plan_domain.month_plan(session, first)
    # Each term converted once, and the totals derived from the converted terms,
    # so the figures on screen add up in pence exactly as displayed (E1).
    income = to_minor(p.income_planned)
    bills, budgets, goals = to_minor(p.bills), to_minor(p.budgets), to_minor(p.goals)
    return MonthPlanOut(
        start=p.start,
        end=p.end,
        today=p.today,
        editable=p.end >= p.today,
        income_planned_minor=income,
        income_received_minor=to_minor(p.income_received),
        bills_minor=bills,
        budgets_minor=budgets,
        goals_minor=goals,
        assigned_minor=bills + budgets + goals,
        unassigned_minor=income - (bills + budgets + goals),
        lines=[
            PlanLineOut(
                kind=line.kind,
                id=line.id,
                name=line.name,
                amount_minor=to_minor(line.amount),
                counted=line.counted,
                note=line.note,
                when=line.when,
                edit_amount_minor=to_minor(line.edit_amount) if line.edit_amount is not None else None,
                period=line.period,
            )
            for line in p.lines
        ],
    )
