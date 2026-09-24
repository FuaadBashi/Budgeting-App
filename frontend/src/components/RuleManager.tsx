"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  applyRule,
  createRule,
  orderRules,
  previewRule,
  updateRule,
  type Account,
  type Category,
  type Rule,
  type RuleInput,
  type RulePreviewRow,
} from "@/lib/api";
import { formatMinor, formatSignedMinor, parseMajorToMinor } from "@/lib/money";
import { ErrorLine, Field, PrimaryButton, SecondaryButton, SectionHeader } from "@/components/ui";

export interface RulePrefill {
  pattern?: string;
  categoryId?: string;
  merchant?: string;
}

const FIELD_LABEL = { either: "Description or merchant", description: "Description", merchant: "Merchant" };
const MATCH_LABEL = { contains: "contains", starts_with: "starts with", equals: "is" };

/** "Description or merchant contains “tesco” · money out · up to £10.00 · on Monzo" */
function describe(rule: Rule, accounts: Map<string, Account>): string {
  const parts = [`${FIELD_LABEL[rule.field]} ${MATCH_LABEL[rule.match]} “${rule.pattern}”`];
  if (rule.direction !== "any") parts.push(rule.direction === "out" ? "money out" : "money in");
  if (rule.amount_min_minor !== null && rule.amount_max_minor !== null) {
    parts.push(`${formatMinor(rule.amount_min_minor)}–${formatMinor(rule.amount_max_minor)}`);
  } else if (rule.amount_min_minor !== null) {
    parts.push(`from ${formatMinor(rule.amount_min_minor)}`);
  } else if (rule.amount_max_minor !== null) {
    parts.push(`up to ${formatMinor(rule.amount_max_minor)}`);
  }
  if (rule.account_id) parts.push(`on ${accounts.get(rule.account_id)?.name ?? "one account"}`);
  return parts.join(" · ");
}

/**
 * Rules run top to bottom and the first match wins, so order is part of what a
 * rule means -- a broad "AMAZON → Shopping" above a narrow "AMAZON PRIME →
 * Subscriptions" would swallow it. Hence the explicit move controls rather than
 * a sort by name.
 */
export function RuleManager({
  rules,
  categories,
  accounts,
  prefill,
}: {
  rules: Rule[];
  categories: Category[];
  accounts: Account[];
  prefill?: RulePrefill;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(prefill ? "new" : null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  async function move(index: number, by: -1 | 1) {
    const ids = rules.map((r) => r.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setError(null);
    try {
      await orderRules(ids);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reorder.");
    }
  }

  async function toggle(rule: Rule) {
    setError(null);
    try {
      await updateRule(rule.id, { active: !rule.active });
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update.");
    }
  }

  return (
    <section>
      <SectionHeader
        title="Rules"
        description="Applied to every imported row, top to bottom; the first match wins. A rule outranks a suggestion from the model."
        action={
          <SecondaryButton onClick={() => setEditing(editing === "new" ? null : "new")} aria-expanded={editing === "new"}>
            {editing === "new" ? "Cancel" : "New rule"}
          </SecondaryButton>
        }
      />

      {error && (
        <div className="mb-3">
          <ErrorLine>{error}</ErrorLine>
        </div>
      )}

      {editing === "new" && (
        <RuleForm
          categories={categories}
          accounts={accounts}
          initial={prefill}
          onDone={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}

      {rules.length === 0 ? (
        <div className="card p-5 text-sm" style={{ color: "var(--text-muted)" }}>
          No rules yet. A rule like “TESCO → Groceries” categorises every future import from that
          merchant, and can be applied to past transactions after you have seen which ones.
        </div>
      ) : (
        <ol className="card divide-y" style={{ borderColor: "var(--gridline)" }}>
          {rules.map((rule, index) => (
            <li key={rule.id} className={`p-4 ${rule.active ? "" : "dimmed"}`}>
              {editing === rule.id ? (
                <RuleForm
                  rule={rule}
                  categories={categories}
                  accounts={accounts}
                  onDone={() => {
                    setEditing(null);
                    router.refresh();
                  }}
                />
              ) : (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-sm font-medium" style={{ color: "var(--text-primary)", overflowWrap: "anywhere" }}>
                      <span className="tnum mr-2 text-xs" style={{ color: "var(--text-muted)" }}>
                        {index + 1}
                      </span>
                      {rule.name}
                      {!rule.active && (
                        <span className="ml-2 text-xs" style={{ color: "var(--text-muted)" }}>
                          off
                        </span>
                      )}
                    </span>
                    <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                      →{" "}
                      {[
                        rule.set_category_id ? categoryNames.get(rule.set_category_id) ?? "a category" : null,
                        rule.set_merchant ? `rename to “${rule.set_merchant}”` : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  </div>
                  <p className="mt-1 text-xs" style={{ color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                    {describe(rule, accountById)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <SecondaryButton onClick={() => void move(index, -1)} disabled={index === 0} aria-label={`Move ${rule.name} up`}>
                      ↑
                    </SecondaryButton>
                    <SecondaryButton onClick={() => void move(index, 1)} disabled={index === rules.length - 1} aria-label={`Move ${rule.name} down`}>
                      ↓
                    </SecondaryButton>
                    <SecondaryButton onClick={() => setEditing(rule.id)}>Edit</SecondaryButton>
                    <SecondaryButton onClick={() => void toggle(rule)}>{rule.active ? "Turn off" : "Turn on"}</SecondaryButton>
                    <SecondaryButton onClick={() => setPreviewing(previewing === rule.id ? null : rule.id)} aria-expanded={previewing === rule.id}>
                      {previewing === rule.id ? "Close" : "Apply to past transactions"}
                    </SecondaryButton>
                  </div>
                  {previewing === rule.id && (
                    <RulePreview
                      rule={rule}
                      categoryNames={categoryNames}
                      onApplied={() => {
                        setPreviewing(null);
                        router.refresh();
                      }}
                    />
                  )}
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function RuleForm({
  rule,
  categories,
  accounts,
  initial,
  onDone,
}: {
  rule?: Rule;
  categories: Category[];
  accounts: Account[];
  initial?: RulePrefill;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(
    Boolean(rule && (rule.direction !== "any" || rule.amount_min_minor !== null || rule.amount_max_minor !== null || rule.account_id)),
  );
  const heldAccounts = accounts.filter((a) => ["current", "cash", "savings", "liability"].includes(a.kind));

  function amount(value: FormDataEntryValue | null): number | null | "bad" {
    const text = String(value ?? "").trim().replace(/^£\s*/, "");
    if (!text) return null;
    return parseMajorToMinor(text) ?? "bad";
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const min = amount(data.get("amount_min"));
    const max = amount(data.get("amount_max"));
    if (min === "bad" || max === "bad") {
      setError("Amounts must look like 10 or 10.50.");
      return;
    }
    const input: RuleInput = {
      name: String(data.get("name") ?? "").trim() || undefined,
      field: data.get("field") as Rule["field"],
      match: data.get("match") as Rule["match"],
      pattern: String(data.get("pattern") ?? "").trim(),
      set_category_id: String(data.get("set_category_id") ?? "") || null,
      set_merchant: String(data.get("set_merchant") ?? "").trim() || null,
      direction: (data.get("direction") as Rule["direction"]) ?? "any",
      amount_min_minor: min,
      amount_max_minor: max,
      account_id: String(data.get("account_id") ?? "") || null,
    };
    if (!advanced) {
      input.direction = "any";
      input.amount_min_minor = null;
      input.amount_max_minor = null;
      input.account_id = null;
    }
    setError(null);
    setBusy(true);
    try {
      if (rule) await updateRule(rule.id, input);
      else await createRule(input);
      onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={`${rule ? "" : "card mb-4 p-5"} space-y-4`}>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem_minmax(0,1fr)]">
        <Field label="When">
          <select name="field" defaultValue={rule?.field ?? "either"} className="form-control">
            <option value="either">Description or merchant</option>
            <option value="description">Description</option>
            <option value="merchant">Merchant</option>
          </select>
        </Field>
        <Field label="Match">
          <select name="match" defaultValue={rule?.match ?? "contains"} className="form-control">
            <option value="contains">contains</option>
            <option value="starts_with">starts with</option>
            <option value="equals">is</option>
          </select>
        </Field>
        <Field label="Text" hint="Case does not matter. “is” ignores the reference numbers banks add.">
          <input name="pattern" required maxLength={200} defaultValue={rule?.pattern ?? initial?.pattern ?? ""} placeholder="tesco" className="form-control" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Set category" optional>
          <select name="set_category_id" defaultValue={rule?.set_category_id ?? initial?.categoryId ?? ""} className="form-control">
            <option value="">Leave as it is</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.nature}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rename merchant to" optional>
          <input name="set_merchant" maxLength={200} defaultValue={rule?.set_merchant ?? initial?.merchant ?? ""} placeholder="Tesco" className="form-control" />
        </Field>
      </div>

      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        aria-expanded={advanced}
        className="text-xs underline"
        style={{ color: "var(--text-secondary)" }}
      >
        {advanced ? "Fewer conditions" : "More conditions: amount, direction, account"}
      </button>

      {advanced && (
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Direction">
            <select name="direction" defaultValue={rule?.direction ?? "any"} className="form-control">
              <option value="any">Either</option>
              <option value="out">Money out</option>
              <option value="in">Money in</option>
            </select>
          </Field>
          <Field label="From" optional>
            <input name="amount_min" inputMode="decimal" defaultValue={rule?.amount_min_minor != null ? (rule.amount_min_minor / 100).toFixed(2) : ""} placeholder="0.00" className="form-control tnum" />
          </Field>
          <Field label="Up to" optional>
            <input name="amount_max" inputMode="decimal" defaultValue={rule?.amount_max_minor != null ? (rule.amount_max_minor / 100).toFixed(2) : ""} placeholder="10.00" className="form-control tnum" />
          </Field>
          <Field label="Only on">
            <select name="account_id" defaultValue={rule?.account_id ?? ""} className="form-control">
              <option value="">Any account</option>
              {heldAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      <Field label="Name" optional hint="Shown on every row this rule categorises. Left blank, it describes itself.">
        <input name="name" maxLength={120} defaultValue={rule?.name ?? ""} className="form-control" />
      </Field>

      {error && <ErrorLine>{error}</ErrorLine>}

      <div className="flex justify-end gap-2">
        {rule && (
          <SecondaryButton onClick={onDone} disabled={busy}>
            Cancel
          </SecondaryButton>
        )}
        <PrimaryButton busy={busy}>{rule ? "Save rule" : "Create rule"}</PrimaryButton>
      </div>
    </form>
  );
}

/**
 * The only way a rule reaches history: see the matches, choose, confirm.
 * Recategorising the past silently would change what closed periods meant.
 */
function RulePreview({
  rule,
  categoryNames,
  onApplied,
}: {
  rule: Rule;
  categoryNames: Map<string, string>;
  onApplied: () => void;
}) {
  const [rows, setRows] = useState<RulePreviewRow[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    previewRule(rule.id)
      .then((found) => {
        if (cancelled) return;
        setRows(found);
        // Pre-select only what would actually change; everything else is shown
        // for context but cannot be applied.
        setChosen(new Set(found.filter(changeable).map((r) => r.transaction_id)));
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load matches.");
      });
    return () => {
      cancelled = true;
    };
  }, [rule.id]);

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await applyRule(rule.id, [...chosen]);
      onApplied();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not apply.");
      setBusy(false);
    }
  }

  if (error) return <div className="mt-3"><ErrorLine>{error}</ErrorLine></div>;
  if (rows === null) {
    return <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>Finding matches…</p>;
  }
  if (rows.length === 0) {
    return <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>No past transactions match this rule.</p>;
  }

  return (
    <div className="mt-3 rounded-[var(--radius-sm)] p-3" style={{ background: "var(--surface-2)" }}>
      <p className="mb-2 text-xs" style={{ color: "var(--text-secondary)" }}>
        {rows.length} past {rows.length === 1 ? "transaction matches" : "transactions match"}. Only the ones
        ticked will change.
      </p>
      <ul className="max-h-72 space-y-1 overflow-y-auto text-xs">
        {rows.map((row) => {
          const can = changeable(row);
          return (
            <li key={row.transaction_id}>
              <label className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2 py-1" style={{ color: can ? "var(--text-secondary)" : "var(--text-muted)" }}>
                <input
                  type="checkbox"
                  disabled={!can}
                  checked={chosen.has(row.transaction_id)}
                  onChange={(e) =>
                    setChosen((current) => {
                      const next = new Set(current);
                      if (e.target.checked) next.add(row.transaction_id);
                      else next.delete(row.transaction_id);
                      return next;
                    })
                  }
                  className="accent-[var(--accent)]"
                />
                <span style={{ overflowWrap: "anywhere" }}>
                  <span className="tnum">{row.booking_date}</span> · {row.merchant || row.description}
                  <span className="block" style={{ color: "var(--text-muted)" }}>
                    {row.skipped
                      ? `Category unchanged: ${row.skipped}`
                      : row.changes_category
                        ? `${row.current_category_id ? categoryNames.get(row.current_category_id) ?? "a category" : "Uncategorised"} → ${rule.set_category_id ? categoryNames.get(rule.set_category_id) ?? "a category" : ""}`
                        : row.changes_merchant
                          ? "Renames the merchant"
                          : "Already matches"}
                  </span>
                </span>
                <span className="tnum">{formatSignedMinor(row.amount_minor)}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex justify-end">
        <PrimaryButton type="button" onClick={() => void apply()} busy={busy} busyLabel="Applying…" disabled={chosen.size === 0}>
          Apply to {chosen.size} {chosen.size === 1 ? "transaction" : "transactions"}
        </PrimaryButton>
      </div>
    </div>
  );
}

function changeable(row: RulePreviewRow): boolean {
  return row.changes_category || row.changes_merchant;
}
