"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { setProtectedBuffer } from "@/lib/api";
import { formatMinor, formatMinorForInput, parseMajorToMinor, type Minor } from "@/lib/money";
import { ErrorLine, Field, PrimaryButton, SectionHeader } from "@/components/ui";

/**
 * The protected cash buffer: cash that safe to spend never counts as spendable,
 * and the line the balance curve warns about. It could only be set in the
 * database before, so the dashboard could do no more than say none was set.
 */
export function BufferSetting({ amountMinor }: { amountMinor: Minor }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Minor | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = String(new FormData(event.currentTarget).get("buffer") || "")
      .trim()
      .replace(/^£\s*/, "")
      .replace(/,/g, "");
    const minor = parseMajorToMinor(raw);
    if (minor === null) {
      setError("Enter an amount like 500 or 500.00. Enter 0 to remove the buffer.");
      return;
    }
    setError(null);
    setSaved(null);
    setBusy(true);
    try {
      const result = await setProtectedBuffer(minor);
      setSaved(result.amount_minor);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="buffer">
      <SectionHeader
        title="Protected cash buffer"
        description="Cash that safe to spend never counts as spendable. The balance curve warns when a bill would take you below it."
      />
      <form onSubmit={onSubmit} className="card space-y-4 p-5">
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {amountMinor > 0 ? (
            <>
              Safe to spend currently holds back{" "}
              <strong className="tnum">{formatMinor(amountMinor)}</strong>.
            </>
          ) : (
            <>No buffer is set, so safe to spend counts every pound of cash.</>
          )}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Buffer">
            <div className="relative">
              <span
                className="absolute left-3 top-1/2 -translate-y-1/2 text-sm"
                style={{ color: "var(--text-muted)" }}
                aria-hidden
              >
                £
              </span>
              <input
                name="buffer"
                inputMode="decimal"
                required
                defaultValue={formatMinorForInput(amountMinor)}
                className="form-control pl-7 tnum"
                aria-describedby="buffer-hint"
              />
            </div>
          </Field>
        </div>
        <p id="buffer-hint" className="text-xs" style={{ color: "var(--text-muted)" }}>
          Often a month of essential bills. Enter 0 to remove it.
        </p>
        {error && <ErrorLine>{error}</ErrorLine>}
        {saved !== null && !error && (
          <p className="text-sm" role="status" style={{ color: "var(--status-good)" }}>
            ✓ Saved. Safe to spend now holds back {formatMinor(saved)}.
          </p>
        )}
        <div className="flex justify-end">
          <PrimaryButton busy={busy}>Save buffer</PrimaryButton>
        </div>
      </form>
    </section>
  );
}
