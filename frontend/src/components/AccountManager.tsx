"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  createAccount,
  createCategory,
  type Account,
  type Category,
} from "@/lib/api";
import { formatMinor, parseMajorToMinor } from "@/lib/money";

type Kind = {
  value: string;
  label: string;
  note: string;
  /** False for the ledger's counterparties, which hold nothing. */
  holdsMoney: boolean;
  owed?: boolean;
};

const KINDS: Kind[] = [
  { value: "current", label: "Current account", note: "Counts toward safe to spend.", holdsMoney: true },
  { value: "cash", label: "Cash", note: "Counts toward safe to spend.", holdsMoney: true },
  { value: "savings", label: "Savings", note: "Kept out of safe to spend; counts toward net worth.", holdsMoney: true },
  { value: "investment", label: "Investment", note: "Counts toward net worth only.", holdsMoney: true },
  { value: "liability", label: "Credit card or loan", note: "Money owed. Reduces net worth.", holdsMoney: true, owed: true },
  { value: "expense", label: "Expense account", note: "Where spending goes, such as Groceries or Rent.", holdsMoney: false },
  { value: "income_source", label: "Income source", note: "Where income comes from, such as Salary.", holdsMoney: false },
];

const GROUPS: { kinds: string[]; label: string; balances: boolean }[] = [
  { kinds: ["current", "cash"], label: "Liquid", balances: true },
  { kinds: ["savings"], label: "Savings", balances: true },
  { kinds: ["investment"], label: "Investments", balances: true },
  { kinds: ["liability"], label: "Liabilities", balances: true },
  // No balance column: nothing reads a counterparty's balance, and a lifetime
  // total of all spending would look like a figure that means something.
  { kinds: ["expense"], label: "Expense accounts", balances: false },
  { kinds: ["income_source"], label: "Income sources", balances: false },
];

/**
 * The one place an entered opening balance becomes a stored one. Liabilities
 * are credit-normal -- money owed is stored negative, so net worth is a plain
 * sum -- and the form asks for "amount owed" as a positive number, because
 * that is how a statement prints it.
 */
function openingBalanceMinor(kind: Kind, entered: number, overdrawn: boolean): number {
  if (kind.owed) return -entered;
  return overdrawn ? -entered : entered;
}

export function AccountManager({
  accounts,
  categories,
}: {
  accounts: Account[];
  categories: Category[];
}) {
  return (
    <div className="space-y-8">
      <AccountsSection accounts={accounts} />
      <CategoriesSection categories={categories} />
    </div>
  );
}

function AccountsSection({ accounts }: { accounts: Account[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(accounts.length === 0);
  const [kindValue, setKindValue] = useState("current");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = KINDS.find((k) => k.value === kindValue) ?? KINDS[0];

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    let opening = 0;
    if (kind.holdsMoney) {
      const raw = String(data.get("opening") || "0").trim().replace(/^£\s*/, "").replace(/,/g, "");
      const overdrawn = !kind.owed && raw.startsWith("-");
      const minor = parseMajorToMinor(overdrawn ? raw.slice(1) : raw);
      if (minor === null) {
        setError("The balance must be an amount like 1250 or 1250.50.");
        return;
      }
      opening = openingBalanceMinor(kind, minor, overdrawn);
    }
    setError(null);
    setBusy(true);
    try {
      await createAccount({
        name: String(data.get("name")).trim(),
        kind: kind.value,
        opening_balance_minor: opening,
      });
      form.reset();
      setKindValue("current");
      setOpen(false);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const grouped = GROUPS.map((g) => ({
    ...g,
    rows: accounts.filter((a) => g.kinds.includes(a.kind)),
  })).filter((g) => g.rows.length > 0);

  return (
    <section>
      <SectionHeader title="Accounts" open={open} onToggle={() => setOpen((v) => !v)} action="New account" />

      {open && (
        <form onSubmit={onSubmit} className="card mb-4 space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kind">
              <select
                name="kind"
                value={kindValue}
                onChange={(e) => setKindValue(e.target.value)}
                className="form-control"
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input
                name="name"
                required
                maxLength={120}
                className="form-control"
                placeholder={kind.holdsMoney ? "Monzo" : kind.value === "expense" ? "Groceries" : "Salary"}
              />
            </Field>
            {kind.holdsMoney && (
              <Field label={kind.owed ? "Amount owed today" : "Balance today"}>
                <div className="relative">
                  <span
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-sm"
                    style={{ color: "var(--text-muted)" }}
                    aria-hidden
                  >
                    £
                  </span>
                  <input
                    name="opening"
                    inputMode="decimal"
                    className="form-control pl-7 tnum"
                    placeholder="0.00"
                    aria-describedby="opening-hint"
                  />
                </div>
              </Field>
            )}
          </div>

          <p id="opening-hint" className="text-xs" style={{ color: "var(--text-muted)" }}>
            {kind.note}{" "}
            {kind.owed
              ? "Enter what you owe as a positive number."
              : kind.holdsMoney
                ? "Put a minus sign in front if the account is overdrawn."
                : "It holds no balance of its own; it is the other side of each transaction."}
          </p>

          {error && (
            <p className="text-sm" role="alert" style={{ color: "var(--status-critical)" }}>
              ✕ {error}
            </p>
          )}

          <div className="flex justify-end">
            <PrimaryButton busy={busy}>Create account</PrimaryButton>
          </div>
        </form>
      )}

      {grouped.length === 0 ? (
        <div className="card p-5 text-sm" style={{ color: "var(--text-muted)" }}>
          No accounts yet.
        </div>
      ) : (
        <div className="card divide-y" style={{ borderColor: "var(--gridline)" }}>
          {grouped.map((group) => (
            <div key={group.label} className="p-4">
              <div className="section-label mb-2">{group.label}</div>
              <ul className="space-y-1.5">
                {group.rows.map((a) => (
                  <li key={a.id} className="flex justify-between gap-3 text-sm">
                    <span style={{ color: "var(--text-secondary)", overflowWrap: "anywhere" }}>
                      {a.name}
                    </span>
                    {group.balances && (
                      <span
                        className="tnum shrink-0"
                        style={{
                          color: a.balance_minor < 0 ? "var(--status-critical)" : "var(--text-primary)",
                        }}
                      >
                        {formatMinor(a.balance_minor)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** "Food › Takeaway". Depth-capped because a parent cycle is insertable. */
function pathLabel(category: Category, byId: Map<string, Category>): string {
  const names = [category.name];
  let parent = category.parent_id ? byId.get(category.parent_id) : undefined;
  for (let depth = 0; parent && depth < 16; depth++) {
    names.unshift(parent.name);
    parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
  }
  return names.join(" › ");
}

function CategoriesSection({ categories }: { categories: Category[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const labelled = categories
    .map((c) => ({ category: c, label: pathLabel(c, byId) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError(null);
    setBusy(true);
    try {
      await createCategory({
        name: String(data.get("name")).trim(),
        parent_id: String(data.get("parent_id") || "") || null,
        nature: data.get("nature") === "essential" ? "essential" : "discretionary",
      });
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <SectionHeader title="Categories" open={open} onToggle={() => setOpen((v) => !v)} action="New category" />

      {open && (
        <form onSubmit={onSubmit} className="card mb-4 space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Name">
              <input name="name" required maxLength={120} className="form-control" placeholder="Groceries" />
            </Field>
            <Field label="Inside">
              <select name="parent_id" defaultValue="" className="form-control">
                <option value="">Nothing (top level)</option>
                {labelled.map(({ category, label }) => (
                  <option key={category.id} value={category.id}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Nature">
              <select name="nature" defaultValue="discretionary" className="form-control">
                <option value="discretionary">Discretionary</option>
                <option value="essential">Essential</option>
              </select>
            </Field>
          </div>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            A budget for a category counts everything inside it. A budget with no category counts
            only discretionary spending, so rent marked essential never eats into it.
          </p>
          {error && (
            <p className="text-sm" role="alert" style={{ color: "var(--status-critical)" }}>
              ✕ {error}
            </p>
          )}
          <div className="flex justify-end">
            <PrimaryButton busy={busy}>Create category</PrimaryButton>
          </div>
        </form>
      )}

      {labelled.length === 0 ? (
        <div className="card p-5 text-sm" style={{ color: "var(--text-muted)" }}>
          No categories yet. Spending can still be recorded; it shows as uncategorised.
        </div>
      ) : (
        <ul className="card divide-y text-sm" style={{ borderColor: "var(--gridline)" }}>
          {labelled.map(({ category, label }) => (
            <li key={category.id} className="flex justify-between gap-3 px-4 py-2.5">
              <span style={{ color: "var(--text-secondary)", overflowWrap: "anywhere" }}>{label}</span>
              <span className="shrink-0 text-xs capitalize" style={{ color: "var(--text-muted)" }}>
                {category.nature}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SectionHeader({
  title,
  open,
  onToggle,
  action,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  action: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="section-label">{title}</h2>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="min-h-8 rounded-full px-3 text-xs"
        style={{ color: "var(--text-secondary)", boxShadow: "inset 0 0 0 1px var(--hairline-strong)" }}
      >
        {open ? "Cancel" : action}
      </button>
    </div>
  );
}

function PrimaryButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="rounded-full px-4 py-2 text-sm font-medium"
      style={{ background: "var(--accent)", color: "var(--on-accent)", opacity: busy ? 0.6 : 1 }}
    >
      {busy ? "Saving…" : children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}
