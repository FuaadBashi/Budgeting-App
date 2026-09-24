"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  editTransaction,
  voidTransaction,
  type Category,
  type Transaction,
  type TransactionEdit,
} from "@/lib/api";
import { formatSignedMinor } from "@/lib/money";

const CLASS_LABEL: Record<string, string> = {
  income: "Income",
  expense: "Expense",
  refund: "Refund",
  transfer: "Transfer",
  savings_transfer: "To savings",
  investment_contribution: "To investments",
  debt_payment: "Debt payment",
  reimbursement: "Reimbursement",
  unclassified: "Unclassified",
};

function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${Number(d)} ${months[Number(m) - 1]} ${y.slice(2)}`;
}

/**
 * Transaction history with both correction paths attached (rulebook section 2).
 *
 * Void is for money that was wrong: nothing is removed from the ledger
 * (invariant L3), the row stays visible in a dimmed state, and the figures
 * recompute. Edit is for everything else -- description, merchant, category --
 * because voiding a typo claims the money was wrong, drops any obligation match
 * and leaves a duplicate row for ever. The API has always accepted edits; this
 * list offered only Void, so every typo was corrected the destructive way.
 */
export function TransactionList({
  transactions,
  showVoided,
  categories,
  expenseAccountIds,
  accountNames,
}: {
  transactions: Transaction[];
  showVoided: boolean;
  categories: Category[];
  /** Which legs a category describes: Spent is defined on expense accounts. */
  expenseAccountIds: string[];
  /** Names each leg of a split in the edit form. */
  accountNames: Record<string, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expense = new Set(expenseAccountIds);

  async function onVoid(txn: Transaction) {
    setError(null);
    setBusy(txn.id);
    try {
      await voidTransaction(txn.id);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not void.");
    } finally {
      setBusy(null);
    }
  }

  if (transactions.length === 0) {
    return (
      <div className="card p-6 text-sm" style={{ color: "var(--text-muted)" }}>
        No transactions yet. Use <strong>Add</strong> to record one.
      </div>
    );
  }

  return (
    <>
      {error && (
        <p
          className="mb-3 rounded-[var(--radius-sm)] p-3 text-sm"
          style={{ background: "var(--surface-1)", color: "var(--status-critical)" }}
          role="alert"
        >
          ✕ {error}
        </p>
      )}

      <ul className="card divide-y" style={{ borderColor: "var(--gridline)" }}>
        {transactions.map((txn) => {
          const voided = txn.status === "voided";
          if (editing === txn.id) {
            return (
              <li key={txn.id} className="p-4">
                <EditRow
                  txn={txn}
                  categories={categories}
                  expenseLegs={txn.postings.filter((p) => expense.has(p.account_id))}
                  accountNames={accountNames}
                  onDone={() => setEditing(null)}
                />
              </li>
            );
          }
          return (
            // Two lines, not one wrapping row. A single flex row let the
            // description column shrink below an unbreakable merchant name,
            // which then drew straight through the amount ("Exp£54.90").
            <li key={txn.id} className="p-4" style={{ opacity: voided ? 0.5 : 1 }}>
              <div className="flex items-baseline gap-3">
                <span
                  className="hidden w-20 shrink-0 text-xs tnum sm:block"
                  style={{ color: "var(--text-muted)" }}
                >
                  {shortDate(txn.booking_date)}
                </span>
                <span
                  className="min-w-0 flex-1"
                  style={{
                    color: "var(--text-primary)",
                    textDecoration: voided ? "line-through" : undefined,
                    overflowWrap: "anywhere",
                  }}
                >
                  {txn.description || "(no description)"}
                </span>
                {/* Cash effect, not the transaction "amount": a card purchase
                    moves a budget without moving cash, and one number cannot
                    say both. */}
                <span
                  className="tnum shrink-0 text-sm"
                  style={{
                    color:
                      txn.cash_effect_minor < 0
                        ? "var(--text-primary)"
                        : txn.cash_effect_minor > 0
                          ? "var(--success-text)"
                          : "var(--text-muted)",
                  }}
                  title="Effect on liquid cash"
                >
                  {txn.cash_effect_minor === 0
                    ? "no cash effect"
                    : formatSignedMinor(txn.cash_effect_minor)}
                </span>
              </div>

              <div
                className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs sm:pl-[5.75rem]"
                style={{ color: "var(--text-muted)" }}
              >
                <span className="tnum sm:hidden">{shortDate(txn.booking_date)}</span>
                {txn.merchant && <span style={{ overflowWrap: "anywhere" }}>{txn.merchant}</span>}
                <span>{CLASS_LABEL[txn.classification] ?? txn.classification}</span>
                {voided && (
                  <span className="font-medium" style={{ color: "var(--status-critical)" }}>
                    ✕ voided
                  </span>
                )}
                {!voided && (
                  <span className="ml-auto flex gap-2">
                    <RowButton onClick={() => setEditing(txn.id)} label={`Edit ${txn.description}`}>
                      Edit
                    </RowButton>
                    <RowButton
                      onClick={() => void onVoid(txn)}
                      disabled={busy === txn.id}
                      label={`Void ${txn.description}`}
                      critical
                    >
                      {busy === txn.id ? "Voiding…" : "Void"}
                    </RowButton>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
        {showVoided
          ? "Voided rows are shown. Nothing is ever deleted — corrections keep the original."
          : "Voided rows are hidden."}{" "}
        Amounts show the effect on liquid cash, so a card purchase reads as no
        cash effect until the statement is paid.
      </p>
    </>
  );
}

function RowButton({
  children,
  onClick,
  label,
  disabled = false,
  critical = false,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  critical?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="min-h-8 rounded-full px-3 text-xs disabled:opacity-50"
      style={{
        color: critical ? "var(--status-critical)" : "var(--text-secondary)",
        boxShadow: "inset 0 0 0 1px var(--hairline-strong)",
      }}
    >
      {children}
    </button>
  );
}

/**
 * Only the fields the API will take. Amount and date are shown but not
 * editable, with the reason, so the form cannot suggest a correction that the
 * server will refuse.
 */
function EditRow({
  txn,
  categories,
  expenseLegs,
  accountNames,
  onDone,
}: {
  txn: Transaction;
  categories: Category[];
  expenseLegs: Transaction["postings"];
  accountNames: Record<string, string>;
  onDone: () => void;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One expense leg is the only case the API can recategorise unambiguously;
  // a split names no single leg, and a transfer has nothing to categorise.
  const leg = expenseLegs.length === 1 ? expenseLegs[0] : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const description = String(form.get("description") ?? "").trim();
    const merchant = String(form.get("merchant") ?? "").trim() || null;

    // Only what changed. The API applies exactly the keys it is sent.
    const edit: TransactionEdit = {};
    if (description !== txn.description) edit.description = description;
    if (merchant !== (txn.merchant ?? null)) edit.merchant = merchant;
    if (leg) {
      const category = String(form.get("category_id") ?? "") || null;
      if (category !== (leg.category_id ?? null)) edit.category_id = category;
    } else if (expenseLegs.length > 1) {
      // Only the legs that changed, each named, so the server never guesses.
      const changed = expenseLegs
        .map((p) => ({ posting_id: p.id, category_id: String(form.get(`leg-${p.id}`) ?? "") || null, was: p.category_id ?? null }))
        .filter((p) => p.category_id !== p.was)
        .map(({ posting_id, category_id }) => ({ posting_id, category_id }));
      if (changed.length > 0) edit.leg_categories = changed;
    }
    if (Object.keys(edit).length === 0) {
      onDone();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await editTransaction(txn.id, edit);
      onDone();
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label={`Edit ${txn.description}`}>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        <span className="tnum">
          {shortDate(txn.booking_date)} · {formatSignedMinor(txn.cash_effect_minor)}
        </span>{" "}
        — the amount and date are the record of the money itself. To change them,
        void this and record it again.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <EditField label="Description">
          <input
            name="description"
            type="text"
            required
            maxLength={240}
            defaultValue={txn.description}
            autoFocus
            className="form-control"
          />
        </EditField>
        <EditField label="Merchant / payer">
          <input
            name="merchant"
            type="text"
            maxLength={200}
            defaultValue={txn.merchant ?? ""}
            placeholder="Optional"
            className="form-control"
          />
        </EditField>
        {leg && categories.length > 0 && (
          <EditField label="Category">
            <select name="category_id" defaultValue={leg.category_id ?? ""} className="form-control">
              <option value="">Uncategorised</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name} · {category.nature}
                </option>
              ))}
            </select>
          </EditField>
        )}
        {expenseLegs.length > 1 && categories.length > 0 && (
          <fieldset className="space-y-2 sm:col-span-2">
            <legend className="mb-1 text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
              Split across {expenseLegs.length} lines
            </legend>
            {expenseLegs.map((p) => (
              <label key={p.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-xs sm:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)]" style={{ color: "var(--text-secondary)" }}>
                <span style={{ overflowWrap: "anywhere" }}>{accountNames[p.account_id] ?? "Expense"}</span>
                <span className="tnum text-right">{formatSignedMinor(-p.amount_minor)}</span>
                <select name={`leg-${p.id}`} defaultValue={p.category_id ?? ""} className="form-control col-span-2 sm:col-span-1">
                  <option value="">Uncategorised</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name} · {category.nature}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </fieldset>
        )}
      </div>

      {error && (
        <p className="text-sm" style={{ color: "var(--status-critical)" }} role="alert">
          ✕ {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          disabled={saving}
          className="min-h-9 rounded-full px-4 text-sm disabled:opacity-50"
          style={{ color: "var(--text-secondary)" }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="btn-shine min-h-9 rounded-full px-4 text-sm font-medium disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--on-accent)" }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function EditField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}
