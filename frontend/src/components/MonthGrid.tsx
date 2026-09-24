"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getTransactions, type CalendarMonth, type MonthDay, type Transaction } from "@/lib/api";
import { formatMinor, formatSignedMinor } from "@/lib/money";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function shift(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dayOfMonth(iso: string): number {
  return Number(iso.slice(8, 10));
}

/** Monday = 0. Computed in UTC from the ISO date, so no local timezone can move a day. */
function weekdayIndex(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function net(day: MonthDay): number {
  if (day.kind === "actual") return day.money_in_minor + day.money_out_minor;
  return day.events.reduce((sum, e) => sum + e.amount_minor, 0);
}

/**
 * A month at a glance: what happened before today, what is committed after it.
 *
 * The balance curve answers "does it hold?"; this answers "when?" -- which
 * week the rent lands in, which days were heavy. Days past the forecast horizon
 * are shown as unknown rather than as empty, because an empty future day reads
 * as "nothing will happen", which is a claim nobody made.
 */
export function MonthGrid({ data, month }: { data: CalendarMonth; month: string }) {
  const initial = data.days.find((d) => d.day === data.today)?.day ?? data.days[0]?.day ?? null;
  const [selected, setSelected] = useState<string | null>(initial);
  const buttons = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [y, m] = month.split("-").map(Number);
  const lead = data.days.length ? weekdayIndex(data.days[0].day) : 0;

  function focusDay(index: number) {
    const target = data.days[Math.max(0, Math.min(data.days.length - 1, index))];
    if (!target) return;
    setSelected(target.day);
    buttons.current.get(target.day)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      focusDay(index + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusDay(index - weekdayIndex(data.days[index].day));
    } else if (event.key === "End") {
      event.preventDefault();
      focusDay(index + 6 - weekdayIndex(data.days[index].day));
    }
  }

  const chosen = data.days.find((d) => d.day === selected) ?? null;

  // Leading and trailing blanks pad the first and last weeks to seven cells.
  const padded: (MonthDay | null)[] = [...Array.from({ length: lead }, () => null), ...data.days];
  while (padded.length % 7 !== 0) padded.push(null);
  const weeks: (MonthDay | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-display text-lg" style={{ color: "var(--text-primary)" }}>
          {MONTHS[m - 1]} {y}
        </h3>
        <nav className="flex gap-1" aria-label="Month">
          <MonthLink href={`/calendar?month=${shift(month, -1)}`} label="Previous month">←</MonthLink>
          <MonthLink href="/calendar" label="This month">Today</MonthLink>
          <MonthLink href={`/calendar?month=${shift(month, 1)}`} label="Next month">→</MonthLink>
        </nav>
      </div>

      <div role="grid" aria-label={`${MONTHS[m - 1]} ${y}`} className="flex flex-col gap-1">
        <div role="row" className="grid grid-cols-7 gap-1">
          {WEEKDAYS.map((w) => (
            <div key={w} role="columnheader" className="pb-1 text-center text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
              <span className="sm:hidden" aria-hidden>{w.slice(0, 1)}</span>
              <span className="sr-only sm:not-sr-only">{w}</span>
            </div>
          ))}
        </div>
        {/* One row per week, so assistive tech reads "row 3, Wednesday" rather
            than a single 30-cell row. */}
        {weeks.map((week, w) => (
          <div key={w} role="row" className="grid grid-cols-7 gap-1">
            {week.map((d, c) =>
              d === null ? (
                <div key={`blank-${w}-${c}`} role="gridcell" aria-hidden />
              ) : (
                <DayCell
                  key={d.day}
                  day={d}
                  selected={d.day === selected}
                  tabbable={d.day === selected}
                  onSelect={() => setSelected(d.day)}
                  onKeyDown={(e) => onKeyDown(e, data.days.indexOf(d))}
                  buttonRef={(el) => {
                    if (el) buttons.current.set(d.day, el);
                    else buttons.current.delete(d.day);
                  }}
                />
              ),
            )}
          </div>
        ))}
      </div>

      <Legend />

      {chosen && <DayDetail day={chosen} bufferMinor={data.protected_buffer_minor} />}
    </div>
  );
}

function MonthLink({ href, label, children }: { href: string; label: string; children: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-full px-3 text-xs"
      style={{ color: "var(--text-secondary)", boxShadow: "inset 0 0 0 1px var(--hairline-strong)" }}
    >
      {children}
    </Link>
  );
}

function DayCell({
  day,
  selected,
  tabbable,
  onSelect,
  onKeyDown,
  buttonRef,
}: {
  day: MonthDay;
  selected: boolean;
  tabbable: boolean;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const amount = net(day);
  const hasIncome = day.events.some((e) => e.kind === "income") || day.money_in_minor > 0;
  const hasOut = day.events.some((e) => e.kind === "obligation") || day.money_out_minor < 0;
  const beyond = day.kind === "beyond";
  const label = [
    new Date(`${day.day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }),
    day.kind === "today" ? "today" : null,
    beyond ? "beyond the forecast" : null,
    day.kind === "actual" && day.transactions ? `${day.transactions} transaction${day.transactions === 1 ? "" : "s"}` : null,
    day.events.length ? `${day.events.length} scheduled` : null,
    day.below_buffer ? "below your buffer" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div role="gridcell" aria-selected={selected}>
      <button
        ref={buttonRef}
        type="button"
        tabIndex={tabbable ? 0 : -1}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        aria-label={label}
        className="flex aspect-square w-full flex-col rounded-[var(--radius-sm)] p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] sm:aspect-[4/3] sm:p-1.5"
        style={{
          background: day.below_buffer
            ? "color-mix(in oklab, var(--status-critical) 14%, var(--surface-1))"
            : beyond
              ? "transparent"
              : "var(--surface-1)",
          boxShadow: selected
            ? "inset 0 0 0 2px var(--accent)"
            : day.kind === "today"
              ? "inset 0 0 0 1px var(--accent)"
              : "inset 0 0 0 var(--border-w) var(--hairline)",
          opacity: beyond ? 0.55 : 1,
        }}
      >
        <span
          className="tnum text-xs font-medium"
          style={{ color: day.kind === "today" ? "var(--accent)" : "var(--text-secondary)" }}
        >
          {dayOfMonth(day.day)}
        </span>
        {!beyond && amount !== 0 && (
          <span
            className="tnum mt-auto hidden truncate text-[11px] sm:block"
            style={{ color: amount > 0 ? "var(--success-text)" : "var(--text-primary)" }}
          >
            {formatSignedMinor(amount)}
          </span>
        )}
        {!beyond && (hasIncome || hasOut) && (
          <span className="mt-auto flex gap-0.5 sm:hidden" aria-hidden>
            {hasIncome && <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--series-1)" }} />}
            {hasOut && <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--series-2)" }} />}
          </span>
        )}
      </button>
    </div>
  );
}

function Legend() {
  return (
    <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: "var(--text-muted)" }}>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--series-1)" }} aria-hidden /> Money in
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--series-2)" }} aria-hidden /> Money out
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-sm" style={{ background: "color-mix(in oklab, var(--status-critical) 40%, var(--surface-1))" }} aria-hidden /> Below your buffer
      </span>
      <span>Before today: what happened. From today: what is committed.</span>
    </p>
  );
}

function DayDetail({ day, bufferMinor }: { day: MonthDay; bufferMinor: number }) {
  const [txns, setTxns] = useState<Transaction[] | null>(null);
  const needsLedger = (day.kind === "actual" || day.kind === "today") && day.transactions > 0;

  useEffect(() => {
    if (!needsLedger) return;
    let cancelled = false;
    getTransactions(50, false, { start: day.day, end: day.day })
      .then((rows) => {
        if (!cancelled) setTxns(rows);
      })
      .catch(() => {
        if (!cancelled) setTxns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [day.day, needsLedger]);

  const title = new Date(`${day.day}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });

  return (
    <section className="mt-4 rounded-[var(--radius-sm)] p-4" style={{ background: "var(--page-plane)" }} aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {title}
          {day.kind === "today" && <span style={{ color: "var(--accent)" }}> · today</span>}
        </h4>
        {day.closing_balance_minor !== null && (
          <span className="tnum text-sm" style={{ color: day.below_buffer ? "var(--status-critical)" : "var(--text-secondary)" }}>
            {day.kind === "actual" ? "Closed at" : "Projected"} {formatMinor(day.closing_balance_minor)}
          </span>
        )}
      </div>

      {day.kind === "beyond" && (
        <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
          Beyond the 90-day forecast. Nothing is projected this far ahead.
        </p>
      )}

      {day.below_buffer && bufferMinor > 0 && (
        <p className="mt-2 text-xs" style={{ color: "var(--status-critical)" }}>
          ✕ Below your {formatMinor(bufferMinor)} buffer.
        </p>
      )}

      {(day.kind === "actual" || day.kind === "today") && (
        <div className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
          {day.transactions === 0 ? (
            <p style={{ color: "var(--text-muted)" }}>Nothing recorded.</p>
          ) : (
            <>
              <p className="tnum">
                {day.transactions} transaction{day.transactions === 1 ? "" : "s"}
                {day.money_in_minor > 0 && ` · in ${formatMinor(day.money_in_minor)}`}
                {day.money_out_minor < 0 && ` · out ${formatMinor(-day.money_out_minor)}`}
              </p>
              {txns === null ? (
                <p className="mt-1" style={{ color: "var(--text-muted)" }}>Loading…</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {txns.map((t) => (
                    <li key={t.id} className="flex justify-between gap-3">
                      <span style={{ overflowWrap: "anywhere" }}>{t.merchant || t.description}</span>
                      <span className="tnum shrink-0">
                        {t.cash_effect_minor === 0 ? "no cash effect" : formatSignedMinor(t.cash_effect_minor)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Link
                href={`/transactions?start=${day.day}&end=${day.day}`}
                className="mt-2 inline-block underline"
                style={{ color: "var(--text-secondary)" }}
              >
                Open in Transactions
              </Link>
            </>
          )}
        </div>
      )}

      {day.events.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs" style={{ color: "var(--text-secondary)" }}>
          {day.events.map((e, i) => (
            <li key={`${e.name}-${i}`} className="flex justify-between gap-3">
              <span>
                <span
                  aria-hidden
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                  style={{ background: e.kind === "income" ? "var(--series-1)" : "var(--series-2)" }}
                />
                {e.name}
                <span className="sr-only">{e.kind === "income" ? " (income)" : " (payment)"}</span>
              </span>
              <span className="tnum shrink-0">{formatSignedMinor(e.amount_minor)}</span>
            </li>
          ))}
        </ul>
      )}

      {day.kind === "projected" && day.events.length === 0 && (
        <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
          Nothing committed. The projection assumes no day-to-day spending.
        </p>
      )}
    </section>
  );
}
