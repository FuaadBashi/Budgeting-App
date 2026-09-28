"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { FIELD_HELP, SCREEN_GUIDES } from "@/lib/explanations";
import { formatMinor, formatSignedMinor } from "@/lib/money";

const KEY = "pfos-explain-mode";
const EVENT = "pfos-explain-mode-change";
let volatileValue: boolean | null = null;
function subscribe(notify: () => void) {
  window.addEventListener(EVENT, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(EVENT, notify);
    window.removeEventListener("storage", notify);
  };
}
function snapshot() {
  if (volatileValue !== null) return volatileValue;
  try { return window.localStorage.getItem(KEY) === "on"; }
  catch { return false; }
}
function serverSnapshot() { return false; }
export function useExplainMode() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
function toggle() {
  const next = !snapshot();
  try {
    window.localStorage.setItem(KEY, next ? "on" : "off");
    volatileValue = null;
  } catch { volatileValue = next; /* Keep working when browser storage is blocked. */ }
  window.dispatchEvent(new Event(EVENT));
}

export function ExplainToolbar() {
  const enabled = useExplainMode();
  const pathname = usePathname();
  const guide = SCREEN_GUIDES[pathname.split("/")[1] || "dashboard"];
  return (
    <section aria-label="Screen explanations" className="mx-auto w-full max-w-5xl px-4 pt-4 sm:px-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        {enabled && <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Tap an underlined figure for its calculation.</span>}
        <button type="button" role="switch" aria-checked={enabled} onClick={toggle}
          className="explain-toggle inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-xs"
          style={{ borderColor: "var(--hairline-strong)", color: "var(--accent-text)", background: "var(--surface-1)" }}>
          <span aria-hidden className="flex h-5 w-9 items-center rounded-full p-0.5" style={{ background: enabled ? "var(--accent)" : "var(--hairline-strong)" }}>
            <span className={`h-4 w-4 rounded-full ${enabled ? "translate-x-4" : ""}`} style={{ background: "var(--page-plane)" }} />
          </span>
          Explain this screen <span aria-hidden>· {enabled ? "On" : "Off"}</span>
        </button>
      </div>
      {enabled && guide && <details key={pathname} open className="explain-guide card mt-3 p-4">
        <summary className="cursor-pointer text-sm font-medium" style={{ color: "var(--text-primary)" }}>{guide.title} — what everything means</summary>
        <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {guide.items.map(([label, description]) => <div key={label}>
            <dt className="text-xs font-semibold" style={{ color: "var(--accent-text)" }}>{label}</dt>
            <dd className="mt-1 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>{description}</dd>
          </div>)}
        </dl>
        <p className="mt-4 text-xs" style={{ color: "var(--text-muted)" }}>Add records actual money movements. Navigation changes screens; the appearance gear changes the design. Explanation mode changes neither your data nor any calculation.</p>
      </details>}
    </section>
  );
}

export type ExplanationRow = { label: string; value: number | string; description?: string; parts?: ExplanationRow[] };
export type Explanation = { description: string; formula?: string; rows?: ExplanationRow[]; note?: string };

function Rows({ rows }: { rows: ExplanationRow[] }) {
  return <dl className="space-y-3">
    {rows.map((row, i) => <div key={`${row.label}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1">
        <dt className="min-w-0">{row.label}</dt>
        <dd className="tnum font-medium">{typeof row.value === "number" ? formatSignedMinor(row.value) : row.value}</dd>
      {row.description && <dd className="col-span-2 text-xs" style={{ color: "var(--text-muted)" }}>{row.description}</dd>}
      {row.parts?.length ? <dd className="col-span-2 mt-2 border-l pl-3 text-xs" style={{ borderColor: "var(--hairline-strong)" }}><Rows rows={row.parts} /></dd> : null}
    </div>)}
  </dl>;
}

/** Values and signed terms are supplied by existing APIs, never recalculated here. */
export function ExplainMetric({ label, explanation, children, result }: {
  label: string; explanation: Explanation; children: ReactNode; result?: number | string;
}) {
  const enabled = useExplainMode();
  if (!enabled) return <>{children}</>;
  return <div className="explain-metric min-w-0">
    <details>
      <summary className="explain-trigger cursor-pointer list-none" aria-label={`Explain ${label}`}>
        <span className="decoration-dotted underline underline-offset-4">{children}</span>
        <span className="mt-1 block font-sans text-xs font-normal" style={{ color: "var(--accent-text)" }}>How this is calculated ↗</span>
      </summary>
      <div className="mt-3 rounded-[var(--radius-sm)] border p-3 text-left font-sans text-sm font-normal leading-relaxed" style={{ borderColor: "var(--hairline-strong)", color: "var(--text-secondary)", background: "var(--surface-2)" }}>
        {explanation.formula && <p className="mb-3 font-medium" style={{ color: "var(--text-primary)" }}>{explanation.formula}</p>}
        {explanation.rows && <Rows rows={explanation.rows} />}
        {result !== undefined && <div className="mt-3 flex flex-wrap justify-between gap-2 border-t pt-2 font-semibold" style={{ borderColor: "var(--hairline-strong)", color: "var(--text-primary)" }}>
          <span>{label}</span><span className="tnum">{typeof result === "number" ? formatMinor(result) : result}</span>
        </div>}
        {explanation.note && <p className="mt-3 text-xs">{explanation.note}</p>}
      </div>
    </details>
    <p className="mt-2 font-sans text-xs font-normal leading-relaxed" style={{ color: "var(--text-secondary)" }}>{explanation.description}</p>
  </div>;
}

export function HelpText({ children }: { children: ReactNode }) {
  return useExplainMode() ? <span className="explain-help mt-2 block text-xs font-normal leading-relaxed" style={{ color: "var(--text-secondary)" }}>{children}</span> : null;
}

export function FieldHelp({ label }: { label: string }) {
  const text = FIELD_HELP[label];
  return text ? <HelpText>{text}</HelpText> : null;
}
