import { AccountDefaults } from "@/components/AccountDefaults";
import { AppShell } from "@/components/AppShell";
import { BudgetCard } from "@/components/BudgetCard";
import { BudgetManager } from "@/components/BudgetManager";
import { MonthPlanView } from "@/components/MonthPlanView";
import { PageTabs } from "@/components/ui";
import { requireSession } from "@/lib/guard";
import {
  getAccounts,
  getBudgetList,
  getBudgets,
  getCategories,
  getIncome,
  getMonthPlan,
  type Account,
  type BudgetPeriod,
  type BudgetSummary,
  type Category,
  type Income,
  type MonthPlan,
} from "@/lib/api";

export const dynamic = "force-dynamic";

type Params = { view?: string; month?: string };

/**
 * Two views of the same budgets. "This period" is how each is doing now;
 * "Plan the month" is the zero-based view -- this month's income, and how much
 * of it the bills, budgets and goals have already claimed.
 */
export default async function BudgetsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const gate = await requireSession();
  if (gate) return gate;
  const params = await searchParams;
  const view = params.view === "plan" ? "plan" : "period";
  const monthParam = params.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.month) ? params.month : undefined;

  let budgets: BudgetSummary[] = [];
  let periods: BudgetPeriod[] = [];
  let categories: Category[] = [];
  let accounts: Account[] = [];
  let plan: MonthPlan | null = null;
  let incomes: Income[] = [];
  let error: string | null = null;

  try {
    if (view === "plan") {
      [plan, incomes, accounts] = await Promise.all([getMonthPlan(monthParam), getIncome(), getAccounts()]);
    } else {
      [budgets, periods, categories, accounts] = await Promise.all([
        getBudgetList(),
        getBudgets(),
        getCategories(),
        getAccounts(),
      ]);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Unknown error";
  }

  return (
    <AppShell>
      <main className="mx-auto max-w-5xl space-y-8 px-4 py-6 sm:px-6 lg:py-10">
        <header>
          <h1
            className="font-display text-xl sm:text-2xl"
            style={{ color: "var(--text-primary)" }}
          >
            Budgets
          </h1>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Editing a budget applies from the current period — closed periods keep the
            amount that was in force
          </p>
        </header>

        <PageTabs
          label="Budget views"
          current={view}
          tabs={[
            { key: "period", label: "This period", href: "/budgets" },
            { key: "plan", label: "Plan the month", href: "/budgets?view=plan" },
          ]}
        />

        {error ? (
          <div className="card p-5 text-sm">
            <span aria-hidden style={{ color: "var(--status-warning)" }}>▲</span>{" "}
            Could not reach the API ({error}).
          </div>
        ) : plan ? (
          <MonthPlanView plan={plan} month={plan.start.slice(0, 7)} incomes={incomes} accounts={accounts} />
        ) : (
          <>
            <section>
              <BudgetManager budgets={budgets} periods={periods} categories={categories} />
            </section>

            <section>
              <AccountDefaults accounts={accounts} categories={categories} />
            </section>

            {periods.length > 0 && (
              <section>
                <h2 className="section-label mb-3">This period</h2>
                <div className="grid gap-4 md:grid-cols-2">
                  {periods.map((p, i) => (
                    <BudgetCard key={p.budget_id} budget={p} index={i} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </AppShell>
  );
}
