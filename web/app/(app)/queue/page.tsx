import type { Metadata } from "next";
import { QueueRoom } from "@/components/queue/queue-room";
import { loadFromApi } from "@/lib/server-api";
import { HealthSchema, IncidentListSchema } from "../../../../src/server/wire";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Queue · Tessera",
  description: "Everything the agent chose not to decide alone, worked one by one without leaving the page.",
};

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const [{ id }, list, health] = await Promise.all([searchParams, loadFromApi("/api/obligations", IncidentListSchema), loadFromApi("/api/health", HealthSchema)]);
  return <QueueRoom initial={list.ok ? list.data.items : []} health={health.ok ? health.data : null} selected={id ?? null} />;
}
