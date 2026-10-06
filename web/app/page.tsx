import { HealthSchema, IncidentListSchema } from "../../src/server/wire";
import { HeroArt } from "@/components/art";
import { Board } from "@/components/board";
import { Frame, Index, Label } from "@/components/ui";
import { loadFromApi } from "@/lib/server-api";

export const dynamic = "force-dynamic";

const PRINCIPLES = [
  {
    title: "One lock per obligation",
    body: "The database itself refuses a second open payout for an obligation. An agent can ask twice, retry, or crash mid-call: the money moves once.",
  },
  {
    title: "Every failure has a playbook",
    body: "All 32 failure codes Airwallex can emit map to a response. Unknown codes fail closed. Possible duplicates, compliance holds and recalls go to a named person.",
  },
  {
    title: "Paid is not final",
    body: "A bank can still return a paid transfer. The Closer waits out a hold, reconciles every wallet line against Airwallex, then signs a certificate.",
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
          <Label>Payment ops incident commander</Label>
          <h1 className="mt-6 font-display text-[clamp(44px,7.4vw,112px)] leading-[0.95] tracking-[0.01em]">
            Pay
            <br />
            once<span className="text-blue">.</span>
          </h1>
          <p className="mt-8 max-w-xl text-lg leading-relaxed text-muted">
            Agents can read your balances. PayOnce lets them move money without ever paying a supplier twice: a payout
            gateway that cannot be talked into a duplicate, a commander that decides wait, replace or escalate, and a
            closer that proves the books tie out.
          </p>
          <p className="mt-6 flex items-center gap-3 text-sm">
            <span aria-hidden className="size-2 bg-blue" />
            Built on the Airwallex sandbox, with Claude reading the supplier&apos;s side of the story.
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
              <p className="font-display text-2xl tracking-wide">API offline</p>
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
