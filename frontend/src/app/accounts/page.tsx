import { AccountManager } from "@/components/AccountManager";
import { AppShell } from "@/components/AppShell";
import { SetupChecklist } from "@/components/SetupChecklist";
import { requireSession } from "@/lib/guard";
import { getAccounts, getCategories, type Account, type Category } from "@/lib/api";
import { setupSteps } from "@/lib/setup";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const gate = await requireSession();
  if (gate) return gate;

  let accounts: Account[] = [];
  let categories: Category[] = [];
  let error: string | null = null;
  try {
    [accounts, categories] = await Promise.all([getAccounts(), getCategories()]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Unknown error";
  }

  const steps = setupSteps(accounts);

  return (
    <AppShell>
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:py-10">
        <header>
          <h1 className="font-display text-xl sm:text-2xl" style={{ color: "var(--text-primary)" }}>
            Accounts
          </h1>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Where money is held, where it comes from and where it goes
          </p>
        </header>

        {error ? (
          <div className="card p-5 text-sm">
            <span aria-hidden style={{ color: "var(--status-warning)" }}>▲</span>{" "}
            Could not reach the API ({error}).
          </div>
        ) : (
          <>
            {steps.some((s) => !s.done) && <SetupChecklist steps={steps} />}
            <AccountManager accounts={accounts} categories={categories} />
          </>
        )}
      </main>
    </AppShell>
  );
}
