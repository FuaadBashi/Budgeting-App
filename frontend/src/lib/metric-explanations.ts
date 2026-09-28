import type { BudgetPeriod, Derivation, Recovery, SafeToSpend, Term } from "./api";
import type { Explanation, ExplanationRow } from "../components/ExplainMode";
import { formatMinor } from "./money";

function termRows(terms: Term[]): ExplanationRow[] {
  return terms.map(t => ({ label: t.label, value: t.amount_minor, description: t.detail, parts: termRows(t.parts) }));
}

export function safeExplanation(sts: SafeToSpend, trace: Derivation | null): Explanation {
  const details: Record<string, string> = {
    "Liquid cash": "Recorded current-account and physical-cash balances. Expected income is not included.",
    "Committed before next income": `Recorded unpaid hard commitments through ${sts.window_end}. Unentered bills cannot be included.`,
    "Protected buffer": "Your configured minimum cash reserve, not the unassigned remainder of a monthly plan.",
    "Planned contributions still owed": "Goal contributions planned for this month, less contributions already made.",
  };
  // Optional detail requests may fail or observe a later update. Never attach
  // a breakdown with a different total to the displayed snapshot.
  const rows: ExplanationRow[] = trace?.total_minor === sts.safe_to_spend_minor
    ? termRows(trace.terms)
    : sts.breakdown.map(([label, value]) => ({ label, value }));
  return {
    description: "What your current cash supports after the recorded commitments and savings plans are reserved.",
    formula: "Cash − commitments − protected buffer − outstanding goal contributions",
    rows: rows.map(row => ({ ...row, description: details[row.label] ?? row.description })),
    note: sts.safe_to_spend_minor < 0
      ? "This is a shortfall against your plan—not necessarily an overdrawn bank account. A budget target or an expected stipend does not create cash."
      : "Only entered data is considered. Missing bills or transactions can overstate this figure.",
  };
}

export function netWorthExplanation(value: number, trace: Derivation | null): Explanation {
  return {
    description: "Recorded assets less money owed. Savings and investments can count here without being available for daily spending.",
    formula: "Bank + cash + savings + investments − liabilities",
    rows: trace?.total_minor === value ? termRows(trace.terms) : undefined,
    note: trace?.total_minor === value ? trace.note : "Account-level detail is unavailable for this snapshot. Refresh to retry; the displayed total still comes from the ledger.",
  };
}

export function dailyExplanation(budgets: BudgetPeriod[]): Explanation {
  const open = budgets.filter(b => b.presented_allowance_minor !== null);
  return {
    description: "The tightest cash-capped daily allowance among your open budgets—not an additional balance.",
    formula: "Smallest of the daily allowances below (do not add these together)",
    rows: open.map(b => ({ label: b.budget_name, value: b.presented_allowance_minor!,
      description: `${b.days_remaining ?? 0} days left; ${b.binding_constraint === "safe_to_spend" ? "limited by safe-to-spend cash" : "limited by this budget's remaining allowance"}.` })),
    note: open.length
      ? "Each allowance is capped at non-negative safe-to-spend cash divided by days remaining, rounded down to pennies. If safe to spend is negative, the cash cap is £0."
      : "No open budgets means there is no daily allowance to calculate—not unlimited spending.",
  };
}

export function savingsExplanation(r: Recovery | null): Explanation {
  return {
    description: "A month-end planning projection, not a savings-account balance or a promise that the goal is affordable.",
    formula: "Planned monthly contributions − projected cuts to flexible goals (minimum £0)",
    rows: r ? [
      { label: "Planned monthly contributions", value: r.planned_total_minor, description: "Includes contributions already made this month." },
      ...r.flexible_sacrificed.map(g => ({ label: `Reduction: ${g.goal_name}`, value: -g.sacrificed_minor,
        description: "The recovery calculation gives up this flexible contribution to close a cash shortfall." })),
    ] : undefined,
    note: r ? `Already contributed: ${formatMinor(r.already_contributed_minor)}. Projection horizon: ${r.horizon}. ${r.recovery_impossible
      ? `Important: ${formatMinor(r.protected_shortfall_minor)} of protected plans remains unfunded. Protected goals are kept in this projection even when cash cannot cover them; this is not an affordable saving amount.`
      : "Assumes the recorded income and commitments occur as planned; unrecorded everyday spending can reduce what is achievable."}`
      : "The recovery calculation is unavailable. No saving amount has been assumed.",
  };
}

export function budgetExplanation(b: BudgetPeriod): Explanation {
  return {
    description: "The budget is a spending limit, not money held in a separate account.",
    formula: "Remaining = period allowance + rollover − net recorded spending",
    rows: [
      ...b.breakdown.map(([label, value]) => ({ label, value })),
      { label: "Remaining after these terms", value: b.remaining_minor },
      ...(b.state === "open" ? [
        { label: "Days remaining", value: String(b.days_remaining ?? "—") },
        { label: "Uncapped daily allowance", value: b.base_allowance_minor === null ? "Unavailable" : formatMinor(b.base_allowance_minor) },
      ] : []),
    ],
    note: b.state === "open"
      ? "The displayed daily allowance is the smaller of the budget's daily allowance and its safe-to-spend cash cap, rounded down. Spent includes only recorded transactions; an opening remaining allowance does not manufacture past transactions."
      : "This period is not open. Its remaining amount is shown instead of a current daily allowance.",
  };
}
