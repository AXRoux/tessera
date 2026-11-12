import type { Metadata } from "next";
import { ControlRoom } from "@/components/dashboard/control-room";
import { Frame } from "@/components/ui";
import { loadFromApi } from "@/lib/server-api";
import { HealthSchema, IncidentListSchema, IncidentViewSchema, MetricsSchema, WalletsSchema } from "../../../../src/server/wire";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Control room · Tessera",
  description: "The board, the wallets, the agent's run and everything waiting on a person, in one place.",
};

/**
 * Everything the control room shows, read once on the server so the first paint is the real board: the incidents, the
 * numbers the ledger derives from them, the wallets, and one ledger per incident for the activity chart.
 */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ compose?: string }> }) {
  const { compose } = await searchParams;
  const [health, list, metrics, wallets] = await Promise.all([
    loadFromApi("/api/health", HealthSchema),
    loadFromApi("/api/obligations", IncidentListSchema),
    loadFromApi("/api/metrics", MetricsSchema),
    loadFromApi("/api/wallets", WalletsSchema),
  ]);

  if (!list.ok) {
    return (
      <div className="mx-auto max-w-[720px] px-6 py-20">
        <Frame>
          <div className="hatch px-8 py-14 text-center">
            <p className="heading text-2xl">The Tessera API is not reachable</p>
            <p className="mx-auto mt-4 max-w-lg text-sm text-muted">{list.message}</p>
          </div>
        </Frame>
      </div>
    );
  }

  // Each incident's own ledger, for the charts. Ten-ish small reads; the page is dynamic anyway.
  const views = (await Promise.all(list.data.items.map((item) => loadFromApi(`/api/obligations/${encodeURIComponent(item.id)}`, IncidentViewSchema)))).flatMap((read) =>
    read.ok ? [read.data] : [],
  );

  return (
    <ControlRoom
      health={health.ok ? health.data : null}
      initial={list.data.items}
      initialMetrics={metrics.ok ? metrics.data : null}
      initialWallets={wallets.ok ? wallets.data : null}
      initialViews={views}
      compose={compose === "1"}
    />
  );
}
