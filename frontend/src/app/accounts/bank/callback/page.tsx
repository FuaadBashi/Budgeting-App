import { AppShell } from "@/components/AppShell";
import { BankCallback } from "@/components/BankCallback";
import { requireSession } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Where the bank sends the browser back after consent. Completing the
 * connection is a write, so it happens from the client on arrival rather than
 * while rendering a GET, which a prefetch or a refresh could repeat.
 */
export default async function BankCallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; state?: string; error?: string; error_description?: string }>;
}) {
  const gate = await requireSession();
  if (gate) return gate;
  const params = await searchParams;
  return (
    <AppShell>
      <main className="mx-auto max-w-xl px-4 py-10 sm:px-6">
        <BankCallback
          code={params.code ?? null}
          state={params.state ?? null}
          refused={params.error_description ?? params.error ?? null}
        />
      </main>
    </AppShell>
  );
}
