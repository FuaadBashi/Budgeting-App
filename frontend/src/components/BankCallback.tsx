"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { completeBankConnection } from "@/lib/api";

export function BankCallback({
  code,
  state,
  refused,
}: {
  code: string | null;
  state: string | null;
  refused: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // The code is single-use at the bank; a second attempt (React's development
  // double effect, a remount) would fail and replace success with an error.
  const attempted = useRef(false);
  const problem = refused
    ? `The bank did not grant access: ${refused}.`
    : !code || !state
      ? "This page is only reached from your bank, and the link is incomplete."
      : error;

  useEffect(() => {
    if (refused || !code || !state || attempted.current) return;
    attempted.current = true;
    completeBankConnection(code, state)
      .then(() => router.replace("/accounts?tab=bank"))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not finish connecting."));
  }, [code, state, refused, router]);

  return (
    <section className="card p-6 text-sm" role="status" aria-live="polite">
      {problem ? (
        <>
          <p style={{ color: "var(--status-critical)" }}>✕ {problem}</p>
          <Link href="/accounts?tab=bank" className="mt-4 inline-block underline" style={{ color: "var(--text-secondary)" }}>
            Back to bank connections
          </Link>
        </>
      ) : (
        <p style={{ color: "var(--text-secondary)" }}>Finishing the connection with your bank…</p>
      )}
    </section>
  );
}
