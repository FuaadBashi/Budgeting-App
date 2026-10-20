"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { createAccount, createCategory, createTransaction, getAccounts, getTransactions, settleTransaction,
  type Account, type Category, type Transaction, type PostingInput } from "@/lib/api";
import { formatMinor, parseMajorToMinor } from "@/lib/money";

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
type Kind = "expense" | "income" | "transfer" | "refund" | "debt" | "balance" | "other";
const real = (a: Account) => ["cash", "current", "savings", "investment", "liability"].includes(a.kind);

export function QuickEntry({ accounts, categories, done }: { accounts: Account[]; categories: Category[]; done: () => void }) {
  const [kind, setKind] = useState<Kind>("expense");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [category, setCategory] = useState("");
  const [customCategory, setCustomCategory] = useState("");
  const [status, setStatus] = useState<"posted" | "candidate">("posted");
  const [rows, setRows] = useState<Transaction[]>([]);
  const [original, setOriginal] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [mode, setMode] = useState("new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [allAccounts, setAllAccounts] = useState(accounts);
  const [allCategories, setAllCategories] = useState(categories);
  const [otherName, setOtherName] = useState("");
  const [otherKind, setOtherKind] = useState("current");
  const [otherSide, setOtherSide] = useState("");
  const [direction, setDirection] = useState("out");
  const minor = parseMajorToMinor(amount);
  const selected = rows.find(t => t.id === original);
  const pending = rows.find(t => t.id === pendingId);
  const find = (id: string) => allAccounts.find(a => a.id === id);
  const nominal = (k: string, preferred: string) => allAccounts.find(a => a.kind === k && a.name === preferred) ?? allAccounts.find(a => a.kind === k);
  const expense = nominal("expense", "General expenses");
  const correction = allAccounts.find(a => a.name === "Balance correction" && a.kind === "income_source");

  async function loadRows() {
    const result: Transaction[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await getTransactions(200, false, { offset });
      result.push(...page);
      if (page.length < 200) break;
    }
    setRows(result);
  }
  async function changeMode(next: string) {
    setMode(next); setError(""); setBusy(true);
    try { await loadRows(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function changeKind(next: Kind) {
    setKind(next); setFrom(""); setTo(""); setOriginal(""); setError("");
    setCategory(""); setCustomCategory("");
    setOtherSide("");
    if (next === "balance") setStatus("posted");
    if (next === "refund") {
      setBusy(true);
      try { await loadRows(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
    }
  }

  function legs(cat: string | null = category || null): PostingInput[] {
    if (mode === "settle") return pending?.postings ?? [];
    if (minor === null || minor < 0 || !find(from)) return [];
    if (kind === "balance") {
      if (!correction) return [];
      const target = find(from)!.kind === "liability" ? -minor : minor;
      const delta = target - find(from)!.balance_minor;
      return [{ account_id: from, amount_minor: delta }, { account_id: correction.id, amount_minor: -delta }];
    }
    if (minor === 0) return [];
    if (kind === "refund") {
      if (!selected) return [];
      const expenses = selected.postings.filter(p => find(p.account_id)?.kind === "expense" && p.amount_minor > 0);
      const total = expenses.reduce((n, p) => n + p.amount_minor, 0);
      if (!total || minor > total) return [];
      let remaining = minor;
      return [{ account_id: from, amount_minor: minor }, ...expenses.map((p, i) => {
        const share = i === expenses.length - 1 ? remaining : Math.floor(minor * p.amount_minor / total);
        remaining -= share;
        return { account_id: p.account_id, amount_minor: -share, category_id: p.category_id };
      })];
    }
    const target = ["transfer", "debt", "other", "income"].includes(kind) ? find(to) : expense;
    if (!target || target.id === from) return [];
    const sign = kind === "income" || (kind === "other" && direction === "in") ? 1 : -1;
    return [{ account_id: from, amount_minor: sign * minor },
      { account_id: target.id, amount_minor: -sign * minor, category_id: target.kind === "expense" ? cat : null }];
  }
  const preview = legs();
  async function save(e: FormEvent) {
    e.preventDefault(); setError(""); setBusy(true);
    try {
      const fresh = await getAccounts();
      if (preview.some(p => find(p.account_id) && real(find(p.account_id)!) && fresh.find(a => a.id === p.account_id)?.balance_minor !== find(p.account_id)?.balance_minor)) {
        setAllAccounts(fresh);
        throw new Error("An account balance changed. Review the updated preview and save again.");
      }
      if (mode === "settle") {
        if (!pending) throw new Error("Choose a pending entry.");
        await settleTransaction(pending.id, date);
      } else {
        if (!preview.length || !name.trim()) throw new Error("Complete the name, amount and account choices.");
        let cat = category;
        if (cat === "other") {
          if (!customCategory.trim()) throw new Error("Enter the category name.");
          const existing = allCategories.find(c => c.name.toLowerCase() === customCategory.trim().toLowerCase());
          const created = existing ?? await createCategory({ name: customCategory.trim(), nature: "discretionary", parent_id: null });
          cat = created.id; setCategory(cat); setAllCategories(current => existing ? current : [...current, created]);
        }
        if (preview.every(p => p.amount_minor === 0)) throw new Error("This balance already matches; no adjustment needed.");
        await createTransaction({ booking_date: date, description: name.trim(), status,
          reimburses_id: kind === "refund" ? original : null, postings: legs(cat || null) });
      }
      done();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function addAccount() {
    setBusy(true); setError("");
    try {
      if (!otherName.trim()) throw new Error("Enter an account name.");
      const existing = allAccounts.find(a => a.name.toLowerCase() === otherName.trim().toLowerCase());
      if (existing) throw new Error("That account already exists; choose it from the list.");
      const a = await createAccount({ name: otherName.trim(), kind: otherKind, opening_balance_minor: 0 });
      setAllAccounts(current => [...current, a]);
      if (otherSide === "from") setFrom(a.id); else setTo(a.id);
      setOtherSide(""); setOtherName("");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const choices = (list: Account[]) => list.map(a => <option key={a.id} value={a.id}>{a.name}</option>);
  const sourceOptions = allAccounts.filter(real);
  const targetOptions = allAccounts.filter(a => kind === "income" ? a.kind === "income_source" : kind === "debt" ? a.kind === "liability" : kind === "other" ? true : real(a));
  function chooseAccount(value: string, side: string) {
    if (value === "other") { setOtherSide(side); setOtherKind(side === "to" && kind === "income" ? "income_source" : side === "to" && kind === "debt" ? "liability" : "current"); }
    if (side === "from") setFrom(value); else setTo(value);
  }

  return <form onSubmit={save} className="mt-5"><fieldset disabled={busy} className="space-y-4">
    <Field label="Action"><select className="form-control" value={mode} onChange={e => void changeMode(e.target.value)}><option value="new">Add a transaction</option><option value="settle">Mark pending as paid / received</option></select></Field>
    {mode === "settle" ? <Field label="Pending entry"><select required className="form-control" value={pendingId} onChange={e => setPendingId(e.target.value)}><option value="">Choose pending entry</option>{rows.filter(t => t.status === "candidate").map(t => <option key={t.id} value={t.id}>{t.booking_date} · {t.description} · {formatMinor(t.postings.filter(p => p.amount_minor > 0).reduce((n,p) => n+p.amount_minor,0))}</option>)}</select></Field> : <>
      <Field label="Transaction type"><select className="form-control" value={kind} onChange={e => void changeKind(e.target.value as Kind)}>{Object.entries({ expense: "Purchase", income: "Income", transfer: "Transfer", refund: "Refund", debt: "Debt repayment", balance: "Balance update", other: "Other" }).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Product / name"><input className="form-control" value={name} onChange={e => setName(e.target.value)} required maxLength={240} placeholder="e.g. NO stuff" /></Field>
      <Field label={kind === "balance" ? "Actual balance (£); for credit cards enter amount owed" : "Amount (£)"}><input className="form-control" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required pattern="[0-9]+([.][0-9]{1,2})?" /></Field>
      <Field label={kind === "income" || kind === "refund" ? "Receive into account" : "Account / from"}><select className="form-control" required value={from} onChange={e => chooseAccount(e.target.value,"from")}><option value="">Choose account</option>{choices(sourceOptions)}<option value="other">Other — add an account</option></select></Field>
      {["transfer","debt","income","other"].includes(kind) && <Field label={kind === "income" ? "Income source" : "To account"}><select className="form-control" required value={to} onChange={e => chooseAccount(e.target.value,"to")}><option value="">Choose account</option>{choices(targetOptions)}<option value="other">Other — add an account</option></select></Field>}
      {otherSide && <fieldset className="space-y-3 rounded border p-3"><legend>Other account (starts at £0)</legend><Field label="Account name"><input className="form-control" value={otherName} onChange={e=>setOtherName(e.target.value)} /></Field><Field label="Account type"><select className="form-control" value={otherKind} onChange={e=>setOtherKind(e.target.value)}>{(otherSide === "from" ? ["current","cash","savings","investment","liability"] : kind === "income" ? ["income_source"] : kind === "debt" ? ["liability"] : kind === "other" ? ["current","cash","savings","liability","expense","income_source"] : ["current","cash","savings","investment","liability"]).map(k=><option key={k} value={k}>{k.replaceAll("_"," ")}</option>)}</select></Field><button type="button" disabled={busy} onClick={()=>void addAccount()} className="underline">Create account</button></fieldset>}
      {kind === "other" && <Field label="Direction"><select className="form-control" value={direction} onChange={e=>setDirection(e.target.value)}><option value="out">Money out of first account</option><option value="in">Money into first account</option></select></Field>}
      {kind === "refund" && <Field label="Original purchase"><select className="form-control" required value={original} onChange={e=>setOriginal(e.target.value)}><option value="">Choose purchase</option>{rows.filter(t=>t.status === "posted" && t.postings.some(p=>find(p.account_id)?.kind === "expense" && p.amount_minor > 0)).map(t=><option key={t.id} value={t.id}>{t.booking_date} · {t.description}</option>)}</select></Field>}
      {(kind === "expense" || kind === "other") && <Field label="Category"><select className="form-control" value={category} onChange={e=>setCategory(e.target.value)}><option value="">Uncategorised</option>{allCategories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}<option value="other">Other — write a category</option></select></Field>}
      {category === "other" && <Field label="Other category"><input className="form-control" required value={customCategory} onChange={e=>setCustomCategory(e.target.value)} /></Field>}
      {kind !== "balance" && <Field label="Status"><select className="form-control" value={status} onChange={e=>setStatus(e.target.value as "posted"|"candidate")}><option value="posted">Paid / received</option><option value="candidate">Pending — not in balances yet</option></select></Field>}
    </>}
    <Field label={mode === "settle" ? "Settlement date" : "Date"}><input type="date" required className="form-control" value={date} onChange={e=>setDate(e.target.value)} /></Field>
    {kind === "balance" && mode === "new" && <p className="text-sm">An unexplained adjustment, not a purchase. Enter only settled/recorded balances; already-recorded payments must not be deducted again.</p>}
    <div role="status" aria-live="polite" className="rounded border p-3 text-sm space-y-1"><strong>{mode === "new" && status === "candidate" ? "When paid / received (no balance change now)" : "Balance preview"}</strong>{preview.filter(p=>find(p.account_id) && real(find(p.account_id)!)).map(p=>{const a=find(p.account_id)!;return <p key={p.account_id}>{a.name}: {formatMinor(a.balance_minor)} → {formatMinor(a.balance_minor+p.amount_minor)}{a.kind === "liability" ? " (negative = owed)" : ""}</p>;})}<p>Based on balances loaded when you opened Add.</p></div>
    {error && <p role="alert" className="text-sm" style={{color:"var(--status-critical)"}}>{error}</p>}
    <button disabled={busy || (mode === "settle" ? !pending : !preview.length || !!otherSide)} className="rounded-full px-5 py-3 disabled:opacity-50" style={{background:"var(--accent)",color:"var(--on-accent)"}}>{busy ? "Saving…" : mode === "settle" ? "Mark paid / received" : "Save transaction"}</button>
  </fieldset></form>;
}

function Field({label,children}:{label:string;children:ReactNode}) {return <label className="block text-sm"><span className="mb-1 block">{label}</span>{children}</label>;}
