"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  connectBank,
  disconnectBank,
  getBankInstitutions,
  mapBankLink,
  syncBankLink,
  type Account,
  type BankConnection,
  type BankInstitution,
  type BankLink,
  type BankStatus,
  type BankSyncResult,
} from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { ErrorLine, PrimaryButton, SecondaryButton, SectionHeader } from "@/components/ui";

const IMPORTABLE = ["current", "cash", "savings", "liability"];

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/**
 * Bank connections. Everything a sync brings in lands in the Import inbox as
 * candidates -- the bank's feed is more convenient than a statement file, not
 * more trustworthy -- so this screen only connects, maps and fetches.
 */
export function BankManager({
  status,
  connections,
  accounts,
}: {
  status: BankStatus;
  connections: BankConnection[];
  accounts: Account[];
}) {
  if (!status.enabled) return <SetupGuide status={status} />;

  return (
    <div className="space-y-6">
      <ConnectPanel />
      <section>
        <SectionHeader
          title="Connected banks"
          description="Each bank account needs a home in the ledger before it can sync. Rows arrive in the Import inbox for you to accept."
        />
        {connections.length === 0 ? (
          <div className="card p-5 text-sm" style={{ color: "var(--text-muted)" }}>
            No banks connected yet.
          </div>
        ) : (
          <div className="space-y-4">
            {connections.map((c) => (
              <ConnectionCard key={c.id} connection={c} accounts={accounts} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SetupGuide({ status }: { status: BankStatus }) {
  return (
    <section className="card space-y-3 p-5 text-sm" style={{ color: "var(--text-secondary)" }}>
      <h2 className="text-base font-medium" style={{ color: "var(--text-primary)" }}>
        Bank sync is off
      </h2>
      <p>
        It reads transactions from your bank through Open Banking and puts them in the Import inbox,
        where you accept them as you would rows from a statement file. Nothing is sent to a bank
        until you turn it on.
      </p>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          Create an application at Enable Banking in <strong>restricted production</strong> mode. It
          is free, and it can only read accounts you link to it yourself.
        </li>
        <li>Link your own bank accounts to the application in its control panel.</li>
        <li>
          Register <code className="font-mono text-xs">{status.redirect_url}</code> as the
          application&apos;s redirect URL, and save its private key somewhere outside this folder.
        </li>
        <li>
          In <code className="font-mono text-xs">backend/.env</code>, set{" "}
          <code className="font-mono text-xs">BANK_SYNC_PROVIDER=enable_banking</code>,{" "}
          <code className="font-mono text-xs">ENABLE_BANKING_APP_ID</code> and{" "}
          <code className="font-mono text-xs">ENABLE_BANKING_KEY_PATH</code>, install the{" "}
          <code className="font-mono text-xs">bank</code> extra, and restart the API.
        </li>
      </ol>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Pending card payments are skipped until they settle, and each connection lasts up to 90
        days before the bank asks you to renew it.
      </p>
    </section>
  );
}

function ConnectPanel() {
  const [banks, setBanks] = useState<BankInstitution[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    setBusy("list");
    try {
      setBanks(await getBankInstitutions());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not list banks.");
    } finally {
      setBusy(null);
    }
  }

  async function connect(name: string) {
    setError(null);
    setBusy(name);
    try {
      const { url } = await connectBank(name);
      // Leaving the app is the point: consent is given at the bank, which then
      // sends the browser back to the callback page with a one-use code.
      window.location.assign(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start the connection.");
      setBusy(null);
    }
  }

  const matches = (banks ?? []).filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 12);

  return (
    <section className="card p-5">
      <SectionHeader title="Connect a bank" description="You will sign in at your bank to approve read-only access." />
      {banks === null ? (
        <PrimaryButton type="button" onClick={() => void load()} busy={busy === "list"} busyLabel="Finding banks…">
          Choose a bank
        </PrimaryButton>
      ) : (
        <div className="space-y-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search banks"
            aria-label="Search banks"
            className="form-control"
            autoFocus
          />
          <ul className="grid gap-2 sm:grid-cols-2">
            {matches.map((b) => (
              <li key={b.name}>
                <button
                  type="button"
                  onClick={() => void connect(b.name)}
                  disabled={busy !== null}
                  className="flex min-h-11 w-full items-center gap-3 rounded-[var(--radius-sm)] px-3 text-left text-sm disabled:opacity-60"
                  style={{ color: "var(--text-primary)", boxShadow: "inset 0 0 0 1px var(--hairline-strong)" }}
                >
                  {b.logo ? (
                    // Logos come from the provider, not from this app's origin.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={b.logo} alt="" referrerPolicy="no-referrer" className="h-6 w-6 rounded object-contain" />
                  ) : (
                    <span aria-hidden className="h-6 w-6 rounded" style={{ background: "var(--surface-2)" }} />
                  )}
                  {busy === b.name ? "Opening your bank…" : b.name}
                </button>
              </li>
            ))}
          </ul>
          {matches.length === 0 && (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              No bank matches “{query}”.
            </p>
          )}
        </div>
      )}
      {error && <div className="mt-3"><ErrorLine>{error}</ErrorLine></div>}
    </section>
  );
}

function ConnectionCard({ connection, accounts }: { connection: BankConnection; accounts: Account[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const left = daysUntil(connection.valid_until);
  const live = connection.status === "active";

  async function disconnect() {
    setError(null);
    try {
      await disconnectBank(connection.id);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not disconnect.");
    }
  }

  return (
    <article className="card p-5" style={{ opacity: connection.status === "revoked" ? 0.6 : 1 }}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-medium" style={{ color: "var(--text-primary)" }}>
          {connection.bank}
        </h3>
        <span
          className="text-xs"
          style={{
            color:
              connection.status === "expired" || (live && left !== null && left <= 7)
                ? "var(--status-warning)"
                : "var(--text-muted)",
          }}
        >
          {connection.status === "active"
            ? left !== null
              ? `Access for ${left} more day${left === 1 ? "" : "s"}`
              : "Connected"
            : connection.status === "expired"
              ? "▲ Access expired — connect again to keep syncing"
              : "Disconnected"}
        </span>
      </div>

      <ul className="mt-3 divide-y" style={{ borderColor: "var(--gridline)" }}>
        {connection.links.map((link) => (
          <LinkRow key={link.id} link={link} accounts={accounts} live={live} />
        ))}
      </ul>

      {error && <div className="mt-3"><ErrorLine>{error}</ErrorLine></div>}
      {live && (
        <div className="mt-3 flex justify-end">
          <SecondaryButton tone="critical" onClick={() => void disconnect()}>
            Disconnect
          </SecondaryButton>
        </div>
      )}
    </article>
  );
}

function LinkRow({ link, accounts, live }: { link: BankLink; accounts: Account[]; live: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BankSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const homes = accounts.filter((a) => IMPORTABLE.includes(a.kind));
  const home = accounts.find((a) => a.id === link.account_id);

  async function map(accountId: string) {
    setError(null);
    try {
      await mapBankLink(link.id, accountId || null);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
    }
  }

  async function sync() {
    setError(null);
    setBusy(true);
    try {
      setResult(await syncBankLink(link.id));
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sync.");
    } finally {
      setBusy(false);
    }
  }

  // Only an account that holds money can be compared: a card's balance sign
  // is the bank's convention, not the ledger's.
  const comparable = home && link.bank_balance_minor !== null && ["current", "cash", "savings"].includes(home.kind);
  const difference = comparable ? link.bank_balance_minor! - home!.balance_minor : null;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm" style={{ color: "var(--text-primary)" }}>
          {link.name}
          {link.identifier && (
            <span className="ml-2 text-xs" style={{ color: "var(--text-muted)" }}>
              {link.identifier}
            </span>
          )}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs" style={{ color: "var(--text-muted)" }}>
            <span className="sr-only">Ledger account for {link.name}</span>
            <select
              value={link.account_id ?? ""}
              onChange={(e) => void map(e.target.value)}
              disabled={!live}
              className="form-control py-1.5 text-sm"
            >
              <option value="">Not linked to an account</option>
              {homes.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <PrimaryButton type="button" onClick={() => void sync()} busy={busy} busyLabel="Syncing…" disabled={!live || !link.account_id} className="min-h-9">
            Sync now
          </PrimaryButton>
        </div>
      </div>

      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        {link.last_synced_at
          ? `Last synced ${new Date(link.last_synced_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`
          : "Not synced yet"}
        {link.bank_balance_minor !== null && ` · the bank says ${formatMinor(link.bank_balance_minor)}`}
        {difference !== null &&
          (difference === 0
            ? " · matches the ledger"
            : ` · the ledger differs by ${formatMinor(Math.abs(difference))}`)}
      </p>

      {result && (
        <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }} role="status">
          {result.staged > 0 ? (
            <>
              {result.staged} new row{result.staged === 1 ? "" : "s"} in the{" "}
              <Link href="/import" className="underline">
                Import inbox
              </Link>
              .
            </>
          ) : (
            "Nothing new."
          )}
          {result.pending_skipped > 0 && ` ${result.pending_skipped} pending, waiting to settle.`}
          {result.foreign_skipped > 0 && ` ${result.foreign_skipped} in another currency, skipped.`}
        </p>
      )}
      {error && <div className="mt-2"><ErrorLine>{error}</ErrorLine></div>}
    </li>
  );
}
