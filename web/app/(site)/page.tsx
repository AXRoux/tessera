import { HealthSchema, IncidentListSchema, MetricsSchema } from "../../../src/server/wire";
import { Board } from "@/components/board";
import { Benefits } from "@/components/landing/benefits";
import { Cases } from "@/components/landing/cases";
import { Faq } from "@/components/landing/faq";
import { FinalCta } from "@/components/landing/final-cta";
import { Hero } from "@/components/landing/hero";
import { Proof } from "@/components/landing/proof";
import { Container, SectionHead } from "@/components/landing/section";
import { Steps } from "@/components/landing/steps";
import { Logo } from "@/components/logo";
import { Frame, LinkButton } from "@/components/ui";
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
      <Benefits />
      <Steps />

      <section id="console" className="scroll-mt-24 pt-28 sm:pt-36" aria-labelledby="console-title">
        <Container>
          <SectionHead center id="console-title" title="Now try it yourself">
            This is the real console, running on a simulated bank. Open seven incidents, watch the agent work them, try to break it, then take over from it. The walkthrough always tells you what to press next.
          </SectionHead>
          <div className="mt-8 flex flex-col items-center gap-3">
            <LinkButton href="/dashboard" variant="secondary">
              Open the control room
            </LinkButton>
            <p className="text-[13px] text-muted">The same board, with the wallets, the charts and the queue around it.</p>
          </div>
        </Container>
        <div className="mt-14">
          {list.ok ? (
            <Board initial={list.data.items} initialMetrics={metrics.ok ? metrics.data : null} health={health.ok ? health.data : null} />
          ) : !list.ok && list.status === 401 ? (
            // Multi-tenant mode: the board belongs to a workspace, and a visitor has none yet.
            <Container>
              <Frame>
                <div className="px-6 py-16 text-center">
                  <Logo size={44} className="mx-auto mb-6" />
                  <p className="text-2xl font-light tracking-[-0.03em]">Your own control room is one sign-up away</p>
                  <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-muted">
                    Every account gets a private workspace. It opens in offline rehearsal, so everything works at once; bring your Airwallex sandbox keys and any model when you want the real thing.
                  </p>
                  <div className="mt-8 flex flex-wrap justify-center gap-3">
                    <LinkButton href="/sign-up" arrow>
                      Create your workspace
                    </LinkButton>
                    <LinkButton href="/sign-in" variant="secondary">
                      Sign in
                    </LinkButton>
                  </div>
                </div>
              </Frame>
            </Container>
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

      <Cases />
      <Proof />
      <Faq />
      <FinalCta health={health.ok ? health.data : null} />
    </>
  );
}
