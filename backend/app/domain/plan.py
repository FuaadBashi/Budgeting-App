"""The zero-based month plan: give every pound of this month's income a job.

Safe-to-spend asks "what can I spend without breaking a plan?" from the cash on
hand. This asks the planning question underneath it: of the income expected
this month, how much is already spoken for -- by bills, budgets and savings
goals -- and how much has no job yet? The answer is ``unassigned``, and the
plan is balanced when it is zero.

Every term is read from the engine that owns it: income occurrences from the
income rules, bill amounts from obligation instances, budget amounts from each
period's revision (`budgets.revision_for`), goal contributions from the goals
themselves, and money actually received from `analytics.summarise`. Nothing
here is stored; the plan is recomputed on every read.

Two decisions carry the weight:

* **A bill inside a category a budget covers is counted once, in the budget.**
  Rent as an obligation plus a Rent budget would otherwise assign the same
  £1,200 twice and report a shortfall that does not exist. Only budgets scoped
  to a category can cover a bill; a bill with no category is always a bill.
* **Budgets not aligned with the calendar month are pro-rated by day, rounded
  up to the penny.** A weekly £70 budget is £300 in a 30-day month, not £280
  (four weeks) or £350 (five). Rounding up errs towards "already assigned", so
  the unassigned figure is never overstated.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import ROUND_CEILING, Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain import analytics
from app.domain.budgets import revision_for
from app.domain.categories import scope_ids
from app.domain.clock import today as clock_today
from app.domain.income import occurrences as income_occurrences
from app.domain.money import PENCE, ZERO
from app.domain.periods import next_period, period_for
from app.models.planning import Budget, FutureObligation, ObligationInstance, SavingsGoal

INCOME = "income"
BILL = "bill"
BUDGET = "budget"
GOAL = "goal"


@dataclass(frozen=True)
class PlanLine:
    kind: str
    id: uuid.UUID | None
    name: str
    amount: Decimal
    #: False for lines shown for context but not in the sum: a bill a budget
    #: already covers, or an optional commitment.
    counted: bool = True
    note: str = ""
    when: date | None = None
    #: For an editable line, the figure an edit replaces: a budget's amount per
    #: period as in force today (a weekly £10, not its pro-rated monthly share),
    #: or a goal's planned monthly contribution.
    edit_amount: Decimal | None = None
    period: str | None = None


@dataclass
class MonthPlan:
    start: date
    end: date
    today: date
    income_planned: Decimal
    income_received: Decimal
    bills: Decimal
    budgets: Decimal
    goals: Decimal
    lines: list[PlanLine] = field(default_factory=list)

    @property
    def assigned(self) -> Decimal:
        return self.bills + self.budgets + self.goals

    @property
    def unassigned(self) -> Decimal:
        """Income with no job yet. Negative means more is assigned than earned."""
        return self.income_planned - self.assigned


def _month_bounds(first: date) -> tuple[date, date]:
    first = first.replace(day=1)
    last = (first.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    return first, last


def budget_month_amount(budget: Budget, start: date, end: date) -> tuple[Decimal, str]:
    """What a budget assigns to ``[start, end]``, and how that was arrived at.

    Each budget period overlapping the month contributes its own revision's
    amount in proportion to the days they share, so a revision taking effect
    mid-month is honoured period by period rather than averaged.
    """
    revisions = sorted(budget.revisions, key=lambda r: r.effective_from)
    if not revisions:
        return ZERO, ""
    total = ZERO
    partial = False
    p = period_for(budget.period, start, budget.anchor_date)
    while p.start <= end:
        lo = max(p.start, start, budget.start_date)
        hi = min(p.end, end, budget.end_date or p.end)
        if lo <= hi:
            try:
                revision = revision_for(revisions, p, budget.start_date)
            except ValueError:
                revision = None  # period predates the budget entirely
            if revision is not None and revision.active:
                shared = (hi - lo).days + 1
                if shared == p.days:
                    total += revision.amount
                else:
                    partial = True
                    total += revision.amount * shared / p.days
        p = next_period(budget.period, p, budget.anchor_date)
    total = total.quantize(PENCE, rounding=ROUND_CEILING)
    note = f"{budget.period.value}, pro-rated to the month" if partial else ""
    return total, note


def current_amount(budget: Budget, today: date) -> Decimal | None:
    """The per-period amount an edit today would replace, or None if the budget
    has no revision in force today (not started, or ended)."""
    revisions = sorted(budget.revisions, key=lambda r: r.effective_from)
    if not revisions or today < budget.start_date or (budget.end_date and today > budget.end_date):
        return None
    try:
        revision = revision_for(revisions, period_for(budget.period, today, budget.anchor_date), budget.start_date)
    except ValueError:
        return None
    return revision.amount if revision.active else None


def month_plan(session: Session, first: date) -> MonthPlan:
    start, end = _month_bounds(first)
    today = clock_today(session)
    lines: list[PlanLine] = []

    # Income: the plan's income is the expected income, because a plan made on
    # the 1st cannot wait for the salary to land. What actually arrived is
    # shown beside it, from the analytics engine, not recomputed here.
    planned = ZERO
    for when, name, amount in income_occurrences(session, start, end):
        planned += amount
        lines.append(PlanLine(INCOME, None, name, amount, when=when))
    received = analytics.summarise(session, start, end).income

    # Budgets, and the categories they cover.
    budgets_total = ZERO
    covered: dict[uuid.UUID, str] = {}
    for budget in session.scalars(select(Budget).order_by(Budget.name, Budget.id)):
        amount, note = budget_month_amount(budget, start, end)
        if amount == ZERO:
            continue
        budgets_total += amount
        lines.append(PlanLine(BUDGET, budget.id, budget.name, amount, note=note,
                              edit_amount=current_amount(budget, today),
                              period=budget.period.value))
        if budget.category_id is not None:
            for category_id in scope_ids(session, budget.category_id) or ():
                covered.setdefault(category_id, budget.name)

    # Bills: every hard instance due this month, paid or not -- this is the
    # month's plan, and a bill paid on the 2nd still used that income.
    bills_total = ZERO
    rows = session.execute(
        select(ObligationInstance, FutureObligation)
        .join(FutureObligation, ObligationInstance.obligation_id == FutureObligation.id)
        .where(ObligationInstance.due_date >= start)
        .where(ObligationInstance.due_date <= end)
        .where(FutureObligation.active.is_(True))
        .order_by(ObligationInstance.due_date, ObligationInstance.id)
    ).all()
    for instance, obligation in rows:
        inside = covered.get(obligation.category_id) if obligation.category_id else None
        if not obligation.hard:
            lines.append(PlanLine(BILL, obligation.id, obligation.name, instance.amount,
                                  counted=False, note="optional", when=instance.due_date))
        elif inside is not None:
            lines.append(PlanLine(BILL, obligation.id, obligation.name, instance.amount,
                                  counted=False, note=f"inside the {inside} budget",
                                  when=instance.due_date))
        else:
            bills_total += instance.amount
            lines.append(PlanLine(BILL, obligation.id, obligation.name, instance.amount,
                                  when=instance.due_date))

    # Goals: the planned monthly contribution of each active goal.
    goals_total = ZERO
    for goal in session.scalars(
        select(SavingsGoal).where(SavingsGoal.active.is_(True)).order_by(SavingsGoal.name, SavingsGoal.id)
    ):
        if goal.planned_contribution > ZERO:
            goals_total += goal.planned_contribution
            lines.append(PlanLine(GOAL, goal.id, goal.name, goal.planned_contribution,
                                  edit_amount=goal.planned_contribution, period="monthly"))

    return MonthPlan(
        start=start,
        end=end,
        today=today,
        income_planned=planned,
        income_received=received,
        bills=bills_total,
        budgets=budgets_total,
        goals=goals_total,
        lines=lines,
    )
