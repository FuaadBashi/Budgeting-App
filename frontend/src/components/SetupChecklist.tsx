import Link from "next/link";
import type { SetupStep } from "@/lib/setup";

/**
 * Shown while the ledger cannot yet record a transaction. Server-rendered: it
 * is derived from the account list on every load, so it disappears on its own
 * once the last step is done rather than waiting to be dismissed.
 */
export function SetupChecklist({
  steps,
  linkToAccounts = false,
}: {
  steps: SetupStep[];
  linkToAccounts?: boolean;
}) {
  const remaining = steps.filter((s) => !s.done).length;
  return (
    <section
      className="card p-5"
      style={{ boxShadow: "inset 0 0 0 1px var(--accent)" }}
      aria-labelledby="setup-title"
    >
      <h2 id="setup-title" className="text-base font-medium" style={{ color: "var(--text-primary)" }}>
        {remaining === steps.length ? "Set up your accounts" : `${remaining} more to set up`}
      </h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Every transaction has two sides, so the Add button needs an account on each side before it
        can record anything.
      </p>
      <ol className="mt-4 space-y-3">
        {steps.map((step) => (
          <li key={step.key} className="flex gap-3 text-sm">
            <span
              aria-hidden
              className="mt-0.5 shrink-0"
              style={{ color: step.done ? "var(--status-good)" : "var(--text-muted)" }}
            >
              {step.done ? "✓" : "○"}
            </span>
            <span>
              <span style={{ color: "var(--text-primary)" }}>
                {step.label}
                <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
              </span>
              <span className="block text-xs" style={{ color: "var(--text-muted)" }}>
                {step.why}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {linkToAccounts && (
        <Link
          href="/accounts"
          className="mt-5 inline-flex min-h-10 items-center rounded-full px-4 text-sm font-medium"
          style={{ background: "var(--accent)", color: "var(--on-accent)" }}
        >
          Set up accounts
        </Link>
      )}
    </section>
  );
}
