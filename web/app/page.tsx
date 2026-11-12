import { HealthSchema, IncidentListSchema, MetricsSchema } from "../../src/server/wire";
import { Board } from "@/components/board";
import { Faq } from "@/components/landing/faq";
import { Hero } from "@/components/landing/hero";
import { Idea } from "@/components/landing/idea";
import { Problem } from "@/components/landing/problem";
import { Proof } from "@/components/landing/proof";
import { Safety } from "@/components/landing/safety";
import { Container, SectionHead } from "@/components/landing/section";
import { Steps } from "@/components/landing/steps";
import { Logo } from "@/components/logo";
import { Frame } from "@/components/ui";
import { loadFromApi } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [list, health, metrics] = await Promise.all([
    loadFromApi("/api/obligations", IncidentListSchema),
    loadFromApi("/api/health", HealthSchema),
    loadFromApi("/api/metrics", MetricsSchema),
  ]);

  return (
    <>
      <Hero health={health.ok ? health.data : null} />
      <Problem />
      <Idea />
      <Steps />

      <section id="console" className="scroll-mt-24 pt-28 sm:pt-36" aria-labelledby="console-title">
        <Container>
          <SectionHead id="console-title" title="Now try it yourself">
            Everything below is live. Open seven incidents, watch the agent work them, try to break it, then take over from it. The walkthrough tells you what to press next.
          </SectionHead>
        </Container>
        <div className="mt-14">
          {list.ok ? (
            <Board initial={list.data.items} initialMetrics={metrics.ok ? metrics.data : null} health={health.ok ? health.data : null} />
          ) : (
            <Container>
              <Frame>
                <div className="hatch px-6 py-16 text-center">
                  <Logo size={44} className="mx-auto mb-6" />
                  <p className="text-2xl font-light tracking-[-0.03em]">The Tessera API is not reachable</p>
                  <p className="mx-auto mt-4 max-w-lg text-sm text-muted">{list.message}</p>
                </div>
              </Frame>
            </Container>
          )}
        </div>
      </section>

      <Safety />
      <Proof />
      <Faq />
    </>
  );
}
