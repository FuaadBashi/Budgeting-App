import Link from "next/link";
import { AccountsSection, CategoriesSection } from "@/components/AccountManager";
import { AppShell } from "@/components/AppShell";
import { RuleManager } from "@/components/RuleManager";
import { SetupChecklist } from "@/components/SetupChecklist";
import { requireSession } from "@/lib/guard";
import {
  getAccounts,
  getCategories,
  getRules,
  type Account,
  type Category,
  type Rule,
} from "@/lib/api";
import { setupSteps } from "@/lib/setup";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "accounts", label: "Accounts" },
  { key: "categories", label: "Categories" },
  { key: "rules", label: "Rules" },
] as const;

type Tab = (typeof TABS)[number]["key"];

type Params = {
  tab?: string;
  /** Pre-fill for a new rule, from a "make a rule" link elsewhere. */
  pattern?: string;
  category?: string;
  merchant?: string;
};

/**
 * Everything that shapes how money is recorded rather than the money itself:
 * the accounts on each side of a transaction, the categories spending is
 * sorted into, and the rules that do the sorting on import.
 *
 * Tabs are links, not client state, so a tab can be linked to directly -- a
 * transaction's "make a rule" lands on Rules with the form already filled in.
 */
export default async function AccountsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const gate = await requireSession();
  if (gate) return gate;

  const params = await searchParams;
  const tab: Tab = TABS.some((t) => t.key === params.tab) ? (params.tab as Tab) : "accounts";

  let accounts: Account[] = [];
  let categories: Category[] = [];
  let rules: Rule[] = [];
  let error: string | null = null;
  try {
    [accounts, categories, rules] = await Promise.all([getAccounts(), getCategories(), getRules()]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Unknown error";
  }

  const steps = setupSteps(accounts);
  const prefill =
    params.pattern || params.category || params.merchant
      ? { pattern: params.pattern, categoryId: params.category, merchant: params.merchant }
      : undefined;

  return (
    <AppShell>
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:py-10">
        <header>
          <h1 className="font-display text-xl sm:text-2xl" style={{ color: "var(--text-primary)" }}>
            Accounts
          </h1>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Accounts, categories and the rules that sort incoming transactions
          </p>
        </header>

        <nav
          aria-label="Accounts sections"
          className="flex gap-1 overflow-x-auto rounded-[var(--radius-sm)] p-1"
          style={{ background: "var(--surface-2)" }}
        >
          {TABS.map((t) => {
            const current = t.key === tab;
            return (
              <Link
                key={t.key}
                href={t.key === "accounts" ? "/accounts" : `/accounts?tab=${t.key}`}
                aria-current={current ? "page" : undefined}
                className="min-h-9 flex-1 whitespace-nowrap rounded-[var(--radius-sm)] px-3 py-2 text-center text-sm font-medium"
                style={
                  current
                    ? { background: "var(--surface-1)", color: "var(--text-primary)", boxShadow: "var(--shadow-raised)" }
                    : { color: "var(--text-secondary)" }
                }
              >
                {t.label}
                {t.key === "rules" && rules.length > 0 && (
                  <span className="tnum ml-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
                    {rules.filter((r) => r.active).length}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {error ? (
          <div className="card p-5 text-sm">
            <span aria-hidden style={{ color: "var(--status-warning)" }}>▲</span>{" "}
            Could not reach the API ({error}).
          </div>
        ) : (
          <>
            {tab === "accounts" && (
              <>
                {steps.some((s) => !s.done) && <SetupChecklist steps={steps} />}
                <AccountsSection accounts={accounts} />
              </>
            )}
            {tab === "categories" && <CategoriesSection categories={categories} />}
            {tab === "rules" && (
              <RuleManager rules={rules} categories={categories} accounts={accounts} prefill={prefill} />
            )}
          </>
        )}
      </main>
    </AppShell>
  );
}
