import { HealthSchema, IncidentListSchema } from "../../src/server/wire";
import { Logo } from "@/components/logo";
import { Board } from "@/components/board";
import { Frame, Index, Label } from "@/components/ui";
import { loadFromApi } from "@/lib/server-api";

export const dynamic = "force-dynamic";

const CHAPTERS = [
  {
    title: "A payment that cannot repeat itself",
    body: "Most duplicate payments are not malicious. They are retries: a timeout, an anxious agent, a second click. So the rule does not live in a prompt, where it could be argued with. It lives in the database, which will simply refuse a second open payment for the same invoice. Ask twice, crash halfway through, start again. The money still moves once.",
  },
  {
    title: "Every failure gets its own answer",
    body: "Airwallex can fail a transfer in 32 different ways, and no two of them deserve quite the same response. A mistyped account number calls for a phone call. A bank timeout can be tried again once the money is safely back. A compliance hold, a recall or a possible duplicate calls for a person. Tessera has an answer for each, and treats anything it has never seen before as unsafe.",
  },
  {
    title: "Paid is a claim, not a fact",
    body: "Airwallex can tell you a payment is paid, and a bank can still send it back days later. So Tessera takes nobody's word for it, its own included. It waits, checks every line in the wallet against Airwallex's records, and only then signs a certificate that says what happened, to the cent.",
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
          <Label>Payment exception management</Label>
          <h1 className="mt-6 font-display text-[clamp(40px,6.6vw,96px)] leading-[0.95] tracking-[0.01em]">
            Tessera<span className="text-blue">.</span>
          </h1>
          <p className="mt-8 max-w-xl text-[clamp(22px,2.4vw,30px)] font-semibold leading-snug">
            Money that moves once, and can prove it.
          </p>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
            When a supplier says the money never arrived, the dangerous move is to pay again. Tessera sits between your
            agents and your bank so that cannot happen. One open payment per invoice, a clear call on what to do next, and
            a signed record that the books balance.
          </p>
          <p className="mt-6 flex items-center gap-3 text-sm">
            <span aria-hidden className="size-2 shrink-0 bg-blue" />
            Built on the Airwallex sandbox. Claude reads what the supplier says; code decides what is allowed.
          </p>
        </div>
        <div className="mx-auto w-full max-w-[440px] lg:col-span-5">
          <Logo size={440} large label="Tessera: a card marked 1×, the mark of a payment that happens once" className="h-auto w-full" />
        </div>
      </section>

      {list.ok ? (
        <Board initial={list.data.items} health={health.ok ? health.data : null} />
      ) : (
        <section className="mx-auto max-w-[1440px] px-6 sm:px-10">
          <Frame>
            <div className="hatch px-6 py-16 text-center">
              <Logo size={44} className="mx-auto mb-6" />
              <p className="font-display text-2xl tracking-wide">The Tessera API is not reachable</p>
              <p className="mx-auto mt-4 max-w-lg text-sm text-muted">{list.message}</p>
            </div>
          </Frame>
        </section>
      )}

      <section id="method" className="mx-auto max-w-[1440px] scroll-mt-8 px-6 pt-24 sm:px-10">
        <Label>Method</Label>
        <h2 className="mt-4 max-w-5xl text-balance font-display text-3xl leading-tight tracking-wide sm:text-4xl">
          Let the model read. Let the code decide.
        </h2>
        <p className="mt-8 max-w-2xl text-lg leading-relaxed text-muted">
          An agent is wonderful at reading a messy email and sensing that something is off. It is a poor thing to trust with
          a wire transfer. So Tessera divides the work along that line. The model reads and explains. A small amount of
          plain, unglamorous code decides what is allowed, and that code cannot be talked around.
        </p>

        <div className="mt-14 grid gap-px bg-rule md:grid-cols-3">
          {CHAPTERS.map((chapter, i) => (
            <article key={chapter.title} className="bg-paper p-8 pr-10">
              <Index n={i + 1} />
              <h3 className="mt-8 text-xl font-semibold leading-snug">{chapter.title}</h3>
              <p className="mt-4 leading-relaxed text-muted">{chapter.body}</p>
            </article>
          ))}
        </div>

        <p className="mt-12 flex max-w-2xl items-start gap-4 text-xl font-semibold leading-snug">
          <span aria-hidden className="mt-2.5 size-2.5 shrink-0 bg-blue" />
          The result is an agent you can leave alone with the books. When it is unsure, it asks a person.
        </p>
      </section>
    </>
  );
}
