import type { Account } from "@/lib/api";

export interface SetupStep {
  key: string;
  label: string;
  why: string;
  done: boolean;
}

/**
 * What a ledger needs before the Add form can record anything.
 *
 * Double entry means every transaction has two sides, so "record an expense"
 * needs an account the money leaves *and* an expense account it goes to. A
 * fresh install has neither, and the Add form's account pickers were simply
 * empty -- with the dashboard meanwhile reporting "On plan." against nothing.
 * The kinds here are the ones TransactionEntry actually offers for each side.
 */
export function setupSteps(accounts: Account[]): SetupStep[] {
  const has = (...kinds: string[]) => accounts.some((a) => kinds.includes(a.kind));
  return [
    {
      key: "held",
      label: "An account that holds money",
      why: "A current account or cash. Safe to spend is worked out from these.",
      done: has("current", "cash"),
    },
    {
      key: "expense",
      label: "An expense account",
      why: "Where spending goes, such as Groceries or Rent. Needed to record an expense.",
      done: has("expense"),
    },
    {
      key: "income",
      label: "An income source",
      why: "Where income comes from, such as Salary. Needed to record income.",
      done: has("income_source"),
    },
  ];
}
