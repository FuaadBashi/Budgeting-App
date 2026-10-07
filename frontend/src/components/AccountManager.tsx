"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  createAccount,
  createCategory,
  openAccounts,
  renameCategory,
  updateAccount,
  type Account,
  type Category,
} from "@/lib/api";
import { formatMinor, parseMajorToMinor } from "@/lib/money";
import { ErrorLine, Field, PrimaryButton, SecondaryButton, SectionHeader } from "@/components/ui";

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

export function AccountsSection({ accounts }: { accounts: Account[] }) {
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
    rows: openAccounts(accounts).filter((a) => g.kinds.includes(a.kind)),
  })).filter((g) => g.rows.length > 0);
  const archived = accounts.filter((a) => !a.active);

  return (
    <section>
      <SectionHeader
        title="Accounts"
        description="Where money is held, where it comes from and where it goes. Archive an account you have closed once it is empty."
        action={
          <SecondaryButton onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Cancel" : "New account"}
          </SecondaryButton>
        }
      />

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

          {error && <ErrorLine>{error}</ErrorLine>}

          <div className="flex justify-end">
            <PrimaryButton busy={busy}>Create account</PrimaryButton>
          </div>
        </form>
      )}

      {grouped.length === 0 ? (
        <div className="card p-5 text-sm" style={{ color: "var(--text-muted)" }}>
          {archived.length > 0 ? "Every account is archived." : "No accounts yet."}
        </div>
      ) : (
        <div className="card divide-y" style={{ borderColor: "var(--gridline)" }}>
          {grouped.map((group) => (
            <div key={group.label} className="p-4">
              <div className="section-label mb-2">{group.label}</div>
              <ul className="space-y-1.5">
                {group.rows.map((a) => (
                  <AccountRow key={a.id} account={a} showBalance={group.balances} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <details className="card mt-4 p-4">
          <summary className="section-label cursor-pointer">Archived ({archived.length})</summary>
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            Kept so past transactions keep their names. Archived accounts are left out of new
            entries, imports and forecasts until you restore them.
          </p>
          <ul className="mt-3 space-y-1.5">
            {archived.map((a) => (
              <AccountRow key={a.id} account={a} showBalance={false} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * One account with its rename and archive controls. Archiving is refused by
 * the API while the account holds money or anything active still uses it, and
 * the reason it gives is shown under the row as it stands.
 */
function AccountRow({ account, showBalance }: { account: Account; showBalance: boolean }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(body: { name?: string; active?: boolean }) {
    setBusy(true);
    setError(null);
    try {
      await updateAccount(account.id, body);
      setRenaming(false);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-1 text-sm">
      {renaming ? (
        <RenameForm
          current={account.name}
          busy={busy}
          onSave={(name) => void save({ name })}
          onCancel={() => {
            setRenaming(false);
            setError(null);
          }}
          onError={setError}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span
            className="min-w-0 flex-1"
            style={{
              color: account.active ? "var(--text-secondary)" : "var(--text-muted)",
              overflowWrap: "anywhere",
            }}
          >
            {account.name}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {showBalance && (
              <span
                className="tnum"
                style={{
                  color: account.balance_minor < 0 ? "var(--status-critical)" : "var(--text-primary)",
                }}
              >
                {formatMinor(account.balance_minor)}
              </span>
            )}
            <SecondaryButton
              onClick={() => setRenaming(true)}
              disabled={busy}
              aria-label={`Rename ${account.name}`}
            >
              Rename
            </SecondaryButton>
            {account.active ? (
              <SecondaryButton
                onClick={() => save({ active: false })}
                disabled={busy}
                aria-label={`Archive ${account.name}`}
              >
                Archive
              </SecondaryButton>
            ) : (
              <SecondaryButton
                onClick={() => save({ active: true })}
                disabled={busy}
                aria-label={`Restore ${account.name}`}
              >
                Restore
              </SecondaryButton>
            )}
          </div>
        </div>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
    </li>
  );
}

/**
 * The inline rename shared by account and category rows. Blank names are
 * caught here; everything else the API decides, and its reason is shown.
 */
function RenameForm({
  current,
  busy,
  onSave,
  onCancel,
  onError,
  note,
}: {
  current: string;
  busy: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
  note?: string;
}) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") || "").trim();
    if (!name) {
      onError("A name needs at least one visible character.");
      return;
    }
    if (name === current) {
      onCancel();
      return;
    }
    onSave(name);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="name"
          defaultValue={current}
          required
          maxLength={120}
          autoFocus
          aria-label={`New name for ${current}`}
          className="form-control min-w-0 flex-1"
        />
        <PrimaryButton busy={busy}>Save</PrimaryButton>
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
      </div>
      {note && (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {note}
        </p>
      )}
    </form>
  );
}

/**
 * One category with its rename control. A rename relabels history too: past
 * budgets and reports read the name through the category's id, so the note says
 * so before the person saves. Nature and parent are not offered -- the API
 * refuses both, because either would change what a closed period spent.
 */
function CategoryRow({ category, label }: { category: Category; label: string }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(name: string) {
    setBusy(true);
    setError(null);
    try {
      await renameCategory(category.id, name);
      setRenaming(false);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-1 px-4 py-2.5">
      {renaming ? (
        <RenameForm
          current={category.name}
          busy={busy}
          onSave={(name) => void save(name)}
          onCancel={() => {
            setRenaming(false);
            setError(null);
          }}
          onError={setError}
          note="Past budgets and reports will show the new name too. The money in it does not move."
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1" style={{ color: "var(--text-secondary)", overflowWrap: "anywhere" }}>
            {label}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs capitalize" style={{ color: "var(--text-muted)" }}>
              {category.nature}
            </span>
            <SecondaryButton
              onClick={() => setRenaming(true)}
              disabled={busy}
              aria-label={`Rename ${category.name}`}
            >
              Rename
            </SecondaryButton>
          </div>
        </div>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
    </li>
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

export function CategoriesSection({ categories }: { categories: Category[] }) {
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
      <SectionHeader
        title="Categories"
        description="What spending was for. Budgets and rules are scoped by these."
        action={
          <SecondaryButton onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Cancel" : "New category"}
          </SecondaryButton>
        }
      />

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
          {error && <ErrorLine>{error}</ErrorLine>}
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
            <CategoryRow key={category.id} category={category} label={label} />
          ))}
        </ul>
      )}
    </section>
  );
}
