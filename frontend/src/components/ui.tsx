import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The small pieces every form and panel repeats. Each screen used to carry its
 * own copy of a label, a primary button and a section header, and the copies
 * drifted: different paddings, one with `min-h`, one without, one that forgot
 * `--on-accent`. One definition keeps them identical in all four designs.
 */

export function Field({
  label,
  hint,
  optional = false,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        {label}
        {optional && (
          <span className="text-xs font-normal" style={{ color: "var(--text-muted)" }}>
            Optional
          </span>
        )}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-xs font-normal" style={{ color: "var(--text-muted)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}

export function PrimaryButton({
  busy = false,
  busyLabel = "Saving…",
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; busyLabel?: string }) {
  return (
    <button
      type="submit"
      {...rest}
      disabled={busy || rest.disabled}
      className={`btn-shine inline-flex min-h-10 items-center justify-center rounded-full px-4 text-sm font-medium disabled:opacity-60 ${className}`}
      style={{ background: "var(--accent)", color: "var(--on-accent)" }}
    >
      {busy ? busyLabel : children}
    </button>
  );
}

export function SecondaryButton({
  children,
  className = "",
  tone = "neutral",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "neutral" | "critical" }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex min-h-8 items-center justify-center rounded-full px-3 text-xs disabled:opacity-50 ${className}`}
      style={{
        color: tone === "critical" ? "var(--status-critical)" : "var(--text-secondary)",
        boxShadow: "inset 0 0 0 1px var(--hairline-strong)",
      }}
    >
      {children}
    </button>
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="section-label">{title}</h2>
        {description && (
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm" role="alert" style={{ color: "var(--status-critical)" }}>
      ✕ {children}
    </p>
  );
}

/**
 * Sub-views of one screen, as links rather than client state, so each view has
 * a URL: it survives a reload, can be linked to, and works before JavaScript.
 */
export function PageTabs({
  label,
  tabs,
  current,
}: {
  label: string;
  tabs: { key: string; label: string; href: string; count?: number }[];
  current: string;
}) {
  return (
    <nav
      aria-label={label}
      className="flex gap-1 overflow-x-auto rounded-[var(--radius-sm)] p-1"
      style={{ background: "var(--surface-2)" }}
    >
      {tabs.map((t) => {
        const active = t.key === current;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className="min-h-9 flex-1 whitespace-nowrap rounded-[var(--radius-sm)] px-3 py-2 text-center text-sm font-medium"
            style={
              active
                ? { background: "var(--surface-1)", color: "var(--text-primary)", boxShadow: "var(--shadow-raised)" }
                : { color: "var(--text-secondary)" }
            }
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className="tnum ml-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
                {t.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

