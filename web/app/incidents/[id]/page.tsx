import { notFound } from "next/navigation";
import { HealthSchema, IncidentViewSchema } from "../../../../src/server/wire";
import { Frame } from "@/components/ui";
import { WarRoom } from "@/components/war-room/war-room";
import { loadFromApi } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [view, health] = await Promise.all([
    loadFromApi(`/api/obligations/${encodeURIComponent(id)}`, IncidentViewSchema),
    loadFromApi("/api/health", HealthSchema),
  ]);

  if (!view.ok) {
    if (view.status === 404) notFound();
    return (
      <section className="mx-auto max-w-[1440px] px-6 pt-14 sm:px-10">
        <Frame>
          <div className="hatch px-6 py-16 text-center">
            <p className="font-display text-2xl tracking-wide">Cannot load this incident</p>
            <p className="mx-auto mt-4 max-w-lg text-sm text-muted">{view.message}</p>
          </div>
        </Frame>
      </section>
    );
  }

  return <WarRoom initial={view.data} health={health.ok ? health.data : null} />;
}
