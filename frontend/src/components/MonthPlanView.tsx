"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  createIncome,
  updateBudget,
  updateGoal,
  updateIncome,
  type Account,
  type Frequency,
  type Income,
  type MonthPlan,
  type PlanLine,
} from "@/lib/api";
import { formatMinor, parseMajorToMinor } from "@/lib/money";
import { ErrorLine, Field, PrimaryButton, SecondaryButton, SectionHeader } from "@/components/ui";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const FREQUENCY_LABEL: Record<Frequency, string> = {
  daily: "every day",
  weekly: "every week",
  fortnightly: "every two weeks",
  monthly: "every month",
  quarterly: "every quarter",
  annual: "every year",
};
const PER_PERIOD: Record<string, string> = {
  daily: "a day",
  weekly: "a week",
  fortnightly: "a fortnight",
  monthly: "a month",
};

function shift(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1].slice(0, 3)}`;
}

/**
 * Give every pound of this month's income a job.
 *
 * Safe to spend answers "what can I spend today"; this answers the question
 * under it: of what is coming in this month, how much already has a job? The
 * page's one number is what is left -- zero is a finished plan, and below zero
 * is more promised than earned. Every figure comes from the server's plan, and
 * the parts on screen add up to it in pence.
 */
export function MonthPlanView({
  plan,
  month,
  incomes,
  accounts,
}: {
  plan: MonthPlan;
  month: string;
  incomes: Income[];
  accounts: Account[];
}) {
  const [y, m] = month.split("-").map(Number);
  const over = plan.unassigned_minor < 0;
  const byKind = (kind: PlanLine["kind"]) => plan.lines.filter((l) => l.kind === kind);

  return (
    <div className="space-y-6">
      <section className="card p-5 sm:p-6" aria-labelledby="plan-headline">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="section-label">{MONTHS[m - 1]} {y}</p>
            <h2 id="plan-headline" className="sr-only">Left to assign</h2>
            <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
              {over ? "Over-assigned by" : "Left to assign"}
            </p>
            <p
              className="tnum font-display text-3xl sm:text-4xl"
              style={{ color: over ? "var(--status-critical)" : plan.unassigned_minor === 0 ? "var(--success-text)" : "var(--text-primary)" }}
            >
              {formatMinor(Math.abs(plan.unassigned_minor))}
            </p>
            <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
              of {formatMinor(plan.income_planned_minor)} expected ·{" "}
              {formatMinor(plan.income_received_minor)} received so far
            </p>
          </div>
          <nav className="flex gap-1" aria-label="Month">
            <NavLink href={`/budgets?view=plan&month=${shift(month, -1)}`} label="Previous month">←</NavLink>
            <NavLink href="/budgets?view=plan" label="This month">Today</NavLink>
            <NavLink href={`/budgets?view=plan&month=${shift(month, 1)}`} label="Next month">→</NavLink>
          </nav>
        </div>

        <AllocationBar plan={plan} />

        {plan.income_planned_minor === 0 && (
          <p className="mt-4 text-sm" style={{ color: "var(--status-warning)" }}>
            ▲ No expected income is configured for this month. Add an income source below.
            Money already received is shown for comparison; this forward plan is built from
            expected income.
          </p>
        )}
        {plan.unassigned_minor === 0 && plan.income_planned_minor > 0 && (
          <p className="mt-4 text-sm" style={{ color: "var(--success-text)" }}>
            ✓ Every pound has a job.
          </p>
        )}
        {!plan.editable && (
          <p className="mt-4 text-xs" style={{ color: "var(--text-muted)" }}>
            This month is over. Its plan is shown as it stood; budget changes apply from the
            current period.
          </p>
        )}
      </section>

      <IncomeSection lines={byKind("income")} incomes={incomes} accounts={accounts} total={plan.income_planned_minor} />

      <LineSection
        title="Bills"
        description="Committed payments due this month. A bill inside a budgeted category is counted once, in the budget."
        lines={byKind("bill")}
        total={plan.bills_minor}
        empty="No commitments due this month."
      />

      <LineSection
        title="Budgets"
        description="What each budget allows this month. Weekly and fortnightly budgets are pro-rated by day."
        lines={byKind("budget")}
        total={plan.budgets_minor}
        empty="No budgets run this month."
        editable={plan.editable ? "budget" : undefined}
      />

      <LineSection
        title="Savings goals"
        description="Planned monthly contributions."
        lines={byKind("goal")}
        total={plan.goals_minor}
        empty="No savings planned."
        editable={plan.editable ? "goal" : undefined}
        footer={
          <Link href="/goals" className="underline">
            Manage goals
          </Link>
        }
      />
    </div>
  );
}

function NavLink({ href, label, children }: { href: string; label: string; children: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-full px-3 text-xs"
      style={{ color: "var(--text-secondary)", boxShadow: "inset 0 0 0 1px var(--hairline-strong)" }}
    >
      {children}
    </Link>
  );
}

/**
 * Income split into what already has a job. Labelled with figures, not colour
 * alone: the third series hue sits under 3:1 on light surfaces (see Traps).
 */
function AllocationBar({ plan }: { plan: MonthPlan }) {
  const base = Math.max(plan.income_planned_minor, plan.assigned_minor, 1);
  const parts = [
    { key: "Bills", minor: plan.bills_minor, colour: "var(--series-2)" },
    { key: "Budgets", minor: plan.budgets_minor, colour: "var(--series-1)" },
    { key: "Goals", minor: plan.goals_minor, colour: "var(--series-3)" },
  ];
  return (
    <div className="mt-5">
      <div
        className="flex h-3 w-full overflow-hidden rounded-full"
        style={{ background: "var(--surface-2)" }}
        role="img"
        aria-label={`Of ${formatMinor(plan.income_planned_minor)} expected: bills ${formatMinor(plan.bills_minor)}, budgets ${formatMinor(plan.budgets_minor)}, goals ${formatMinor(plan.goals_minor)}.`}
      >
        {parts.map((p) =>
          p.minor > 0 ? (
            <span key={p.key} style={{ width: `${(p.minor / base) * 100}%`, background: p.colour }} />
          ) : null,
        )}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs" style={{ color: "var(--text-secondary)" }}>
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-sm" style={{ background: p.colour }} />
            {p.key} <span className="tnum">{formatMinor(p.minor)}</span>
          </li>
        ))}
        <li className="tnum" style={{ color: "var(--text-muted)" }}>
          Assigned {formatMinor(plan.assigned_minor)}
        </li>
      </ul>
    </div>
  );
}

function LineSection({
  title,
  description,
  lines,
  total,
  empty,
  editable,
  footer,
}: {
  title: string;
  description: string;
  lines: PlanLine[];
  total: number;
  empty: string;
  editable?: "budget" | "goal";
  footer?: ReactNode;
}) {
  return (
    <section>
      <SectionHeader
        title={title}
        description={description}
        action={<span className="tnum text-sm" style={{ color: "var(--text-primary)" }}>{formatMinor(total)}</span>}
      />
      {lines.length === 0 ? (
        <div className="card p-5 text-sm" style={{ color: "var(--text-muted)" }}>
          {empty}
        </div>
      ) : (
        <ul className="card divide-y" style={{ borderColor: "var(--gridline)" }}>
          {lines.map((line, i) => (
            <li key={`${line.id}-${line.when}-${i}`} className={`p-4 ${line.counted ? "" : "dimmed"}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-sm" style={{ color: "var(--text-primary)", overflowWrap: "anywhere" }}>
                  {line.name}
                  {line.when && (
                    <span className="tnum ml-2 text-xs" style={{ color: "var(--text-muted)" }}>
                      {shortDate(line.when)}
                    </span>
                  )}
                </span>
                <span className="tnum text-sm" style={{ color: "var(--text-primary)" }}>
                  {!line.counted && <span className="sr-only">Not counted: </span>}
                  {formatMinor(line.amount_minor)}
                </span>
              </div>
              {(line.note || !line.counted) && (
                <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                  {!line.counted && "Not counted — "}
                  {line.note}
                </p>
              )}
              {editable && line.id && line.edit_amount_minor !== null && (
                <AmountEditor line={line} kind={editable} />
              )}
            </li>
          ))}
        </ul>
      )}
      {footer && (
        <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
          {footer}
        </p>
      )}
    </section>
  );
}

/**
 * Edits the real number behind a line: a weekly budget's £10, not its pro-rated
 * £42.86. A budget edit appends a revision from the current period; closed
 * periods keep what was in force (invariant B8).
 */
function AmountEditor({ line, kind }: { line: PlanLine; kind: "budget" | "goal" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const per = PER_PERIOD[line.period ?? "monthly"] ?? `per ${line.period}`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = String(new FormData(event.currentTarget).get("amount") ?? "").trim().replace(/^£\s*/, "");
    const minor = parseMajorToMinor(raw);
    if (minor === null) {
      setError("Enter an amount like 250 or 250.50.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (kind === "budget") await updateBudget(line.id!, { amount_minor: minor });
      else await updateGoal(line.id!, { planned_contribution_minor: minor });
      setOpen(false);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
        <span className="tnum">
          {formatMinor(line.edit_amount_minor!)} {per}
        </span>
        <SecondaryButton onClick={() => setOpen(true)} aria-label={`Change ${line.name}`}>
          Change
        </SecondaryButton>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="mt-2 flex flex-wrap items-center gap-2">
      <label className="relative">
        <span className="sr-only">{line.name} amount {per}</span>
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: "var(--text-muted)" }} aria-hidden>
          £
        </span>
        <input
          name="amount"
          inputMode="decimal"
          autoFocus
          defaultValue={(line.edit_amount_minor! / 100).toFixed(2)}
          className="form-control w-32 pl-7 tnum"
        />
      </label>
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>{per}</span>
      <PrimaryButton busy={busy} className="min-h-9">Save</PrimaryButton>
      <SecondaryButton onClick={() => setOpen(false)} disabled={busy}>
        Cancel
      </SecondaryButton>
      {kind === "budget" && (
        <span className="w-full text-xs" style={{ color: "var(--text-muted)" }}>
          Applies from the current period. Past periods keep their amount.
        </span>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
    </form>
  );
}

function IncomeSection({
  lines,
  incomes,
  accounts,
  total,
}: {
  lines: PlanLine[];
  incomes: Income[];
  accounts: Account[];
  total: number;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(incomes.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const receiving = accounts.filter((a) => ["current", "cash", "savings", "investment"].includes(a.kind));

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const minor = parseMajorToMinor(String(data.get("amount") ?? "").trim().replace(/^£\s*/, ""));
    if (minor === null || minor === 0) {
      setError("Enter the amount you are paid, like 2450 or 2450.00.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createIncome({
        name: String(data.get("name")).trim(),
        amount_minor: minor,
        first_expected_date: String(data.get("first_expected_date")),
        frequency: (String(data.get("frequency") || "") || null) as Frequency | null,
        account_id: String(data.get("account_id") || "") || null,
      });
      form.reset();
      setAdding(false);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(income: Income) {
    setError(null);
    try {
      await updateIncome(income.id, { active: !income.active });
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update.");
    }
  }

  return (
    <section>
      <SectionHeader
        title="Income"
        description="What is expected this month. Your pay date also sets how far ahead safe to spend looks."
        action={<span className="tnum text-sm" style={{ color: "var(--text-primary)" }}>{formatMinor(total)}</span>}
      />

      {lines.length > 0 && (
        <ul className="card mb-3 divide-y" style={{ borderColor: "var(--gridline)" }}>
          {lines.map((line, i) => (
            <li key={`${line.name}-${line.when}-${i}`} className="flex justify-between gap-3 p-4 text-sm">
              <span style={{ color: "var(--text-primary)" }}>
                {line.name}
                {line.when && (
                  <span className="tnum ml-2 text-xs" style={{ color: "var(--text-muted)" }}>
                    {shortDate(line.when)}
                  </span>
                )}
              </span>
              <span className="tnum" style={{ color: "var(--success-text)" }}>
                {formatMinor(line.amount_minor)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <details className="card p-4" open={adding || incomes.length === 0}>
        <summary className="cursor-pointer text-sm" style={{ color: "var(--text-secondary)" }}>
          Income sources ({incomes.filter((i) => i.active).length} active)
        </summary>
        {incomes.length > 0 && (
          <ul className="mt-3 space-y-2 text-sm">
            {incomes.map((income) => (
              <li key={income.id} className={`flex flex-wrap items-center justify-between gap-2 ${income.active ? "" : "dimmed"}`}>
                <span style={{ color: "var(--text-primary)" }}>
                  {income.name}{" "}
                  <span className="tnum text-xs" style={{ color: "var(--text-muted)" }}>
                    {formatMinor(income.amount_minor)} {income.frequency ? FREQUENCY_LABEL[income.frequency] : "once"}
                    {income.next_date && ` · next ${shortDate(income.next_date)}`}
                    {!income.active && " · off"}
                  </span>
                </span>
                <SecondaryButton onClick={() => void toggle(income)}>{income.active ? "Stop expecting" : "Expect again"}</SecondaryButton>
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <form onSubmit={onAdd} className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <input name="name" required maxLength={120} placeholder="Salary" className="form-control" />
              </Field>
              <Field label="Amount">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: "var(--text-muted)" }} aria-hidden>
                    £
                  </span>
                  <input name="amount" required inputMode="decimal" placeholder="0.00" className="form-control pl-7 tnum" />
                </div>
              </Field>
              <Field label="Next paid on" hint="The pattern repeats from this date.">
                <input name="first_expected_date" type="date" required className="form-control" />
              </Field>
              <Field label="How often">
                <select name="frequency" defaultValue="monthly" className="form-control">
                  <option value="monthly">Every month</option>
                  <option value="fortnightly">Every two weeks</option>
                  <option value="weekly">Every week</option>
                  <option value="quarterly">Every quarter</option>
                  <option value="annual">Every year</option>
                  <option value="">Just once</option>
                </select>
              </Field>
              <Field label="Paid into" optional>
                <select name="account_id" defaultValue="" className="form-control">
                  <option value="">Not specified</option>
                  {receiving.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            {error && <ErrorLine>{error}</ErrorLine>}
            <div className="flex justify-end gap-2">
              {incomes.length > 0 && (
                <SecondaryButton onClick={() => setAdding(false)} disabled={busy}>
                  Cancel
                </SecondaryButton>
              )}
              <PrimaryButton busy={busy}>Add income</PrimaryButton>
            </div>
          </form>
        ) : (
          <div className="mt-3">
            {error && <ErrorLine>{error}</ErrorLine>}
            <SecondaryButton onClick={() => setAdding(true)}>Add income</SecondaryButton>
          </div>
        )}
      </details>
    </section>
  );
}
