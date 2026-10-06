import { HealthSchema, IncidentListSchema } from "../../src/server/wire";
import { HeroArt } from "@/components/art";
import { Board } from "@/components/board";
import { Frame, Index, Label } from "@/components/ui";
import { loadFromApi } from "@/lib/server-api";

export const dynamic = "force-dynamic";

const PRINCIPLES = [
  {
    title: "One invoice, one open payment",
    body: "The database itself refuses a second open payment for the same invoice. An agent can retry, repeat itself or crash mid-request, and the money still moves once.",
  },
  {
    title: "Every failure has an answer",
    body: "Airwallex can fail a transfer in 32 distinct ways. Each has a defined response, from a quiet retry to a phone call to the supplier. Anything unrecognized is treated as unsafe, and possible duplicates, compliance holds and recalls go to a named person.",
  },
  {
    title: "Paid is not the end",
    body: "A bank can still return a payment that Airwallex reports as paid. PayOnce waits, then checks every line in the wallet against Airwallex's own records before it signs a certificate of completion.",
  },
];

export default async function Home() {
  const [list, health] = await Promise.all([
    loadFromApi("/api/obligations", IncidentListSchema),
    loadFromApi("/api/health", HealthSchema),
  ]);

  return (
    <>
      <section className="mx-auto grid max-w-[1440px] items-center gap-10 px-6 pb-16 pt-14 sm:px-10 lg:grid-cols-12 lg:pb-24 lg:pt-20">
        <div className="lg:col-span-7">
          <Label>Incident command for payouts</Label>
          <h1 className="mt-6 font-display text-[clamp(44px,7.4vw,112px)] leading-[0.95] tracking-[0.01em]">
            Pay
            <br />
            once<span className="text-blue">.</span>
          </h1>
          <p className="mt-8 max-w-xl text-lg leading-relaxed text-muted">
            When a supplier says the money never arrived, the dangerous move is to pay again. PayOnce sits between your
            agents and your bank so that cannot happen: one open payment per invoice, a clear call on what to do next, and
            a signed record that the books balance.
          </p>
          <p className="mt-6 flex items-center gap-3 text-sm">
            <span aria-hidden className="size-2 shrink-0 bg-blue" />
            Built on the Airwallex sandbox. Claude reads what the supplier says; code decides what is allowed.
          </p>
        </div>
        <div className="mx-auto aspect-square w-full max-w-[520px] lg:col-span-5">
          <HeroArt />
        </div>
      </section>

      {list.ok ? (
        <Board initial={list.data.items} health={health.ok ? health.data : null} />
      ) : (
        <section className="mx-auto max-w-[1440px] px-6 sm:px-10">
          <Frame>
            <div className="hatch px-6 py-16 text-center">
              <p className="font-display text-2xl tracking-wide">The PayOnce API is not reachable</p>
              <p className="mx-auto mt-4 max-w-lg text-sm text-muted">{list.message}</p>
            </div>
          </Frame>
        </section>
      )}

      <section id="method" className="mx-auto max-w-[1440px] scroll-mt-8 px-6 pt-24 sm:px-10">
        <Label>Method</Label>
        <h2 className="mt-4 max-w-2xl font-display text-3xl leading-tight tracking-wide sm:text-4xl">
          Code decides what is allowed. The model only reads.
        </h2>
        <div className="mt-12 grid gap-px bg-rule md:grid-cols-3">
          {PRINCIPLES.map((p, i) => (
            <article key={p.title} className="bg-paper p-8 pr-10">
              <Index n={i + 1} />
              <h3 className="mt-8 text-xl font-semibold">{p.title}</h3>
              <p className="mt-4 leading-relaxed text-muted">{p.body}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
