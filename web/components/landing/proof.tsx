import { Icon } from "./icons";
import { Container, SectionHead } from "./section";

const REPO = "https://github.com/AXRoux/tessera";

const TESTS = [
  {
    name: "The red team",
    command: "bun run redteam",
    figure: "50/50",
    caption: "attacks held",
    cta: "See the attacks",
    href: `${REPO}#prove-it`,
    items: [
      "Two payouts at the same instant",
      "A forged or replayed approval",
      "A phishing email that fools the reader",
      "A forged or replayed webhook",
      "An edited audit trail",
      "A woken agent that tries to pay twice",
    ],
    featured: false,
  },
  {
    name: "The crash test",
    command: "bun run chaos",
    figure: "1",
    caption: "transfer after kill -9",
    cta: "See the crash test",
    href: `${REPO}#prove-it`,
    items: [
      "Killed before the request leaves",
      "Killed after Airwallex creates the transfer",
      "Killed in the middle of a conversion",
      "Restarted from the ledger file",
      "Same request ID, chain intact",
      "Runs on the real Airwallex sandbox",
    ],
    featured: true,
  },
  {
    name: "The mutation test",
    command: "bun run mutate",
    figure: "94/94",
    caption: "guards proven load-bearing",
    cta: "See how it works",
    href: `${REPO}#the-tests-have-teeth`,
    items: [
      "Each guard removed from a private copy",
      "The red team and named tests rerun",
      "Fails unless every removal is noticed",
      "Runs in CI on every push",
      "530 tests stand behind it",
      "Your working tree is never touched",
    ],
    featured: false,
  },
];

export function Proof() {
  return (
    <section id="proof" className="scroll-mt-24 pt-28 sm:pt-36" aria-labelledby="proof-title">
      <Container>
        <SectionHead center id="proof-title" title="Do not take our word for it">
          Three commands anyone can run, with no keys. Each one tries to make Tessera pay twice, and each one fails.
        </SectionHead>
        <div className="mt-14 grid items-stretch gap-6 lg:grid-cols-3">
          {TESTS.map((t) => (
            <article
              key={t.name}
              className={`flex flex-col rounded-[28px] p-8 ${t.featured ? "glow-card border-blue/70 ring-2 ring-blue/60" : "card"}`}
            >
              <div className="flex items-center gap-3">
                <span aria-hidden className="inline-flex size-11 items-center justify-center rounded-full bg-white text-black">
                  <Icon name="activity" className="size-5" />
                </span>
                <div>
                  <h3 className="text-[20px] font-medium tracking-[-0.02em]">{t.name}</h3>
                  <p className="font-mono text-[12px] text-white/65">{t.command}</p>
                </div>
              </div>
              <p className="mt-10">
                <span className="tnum block text-[clamp(52px,6vw,68px)] font-light leading-none tracking-[-0.05em]">{t.figure}</span>
                <span className="mt-3 block text-[14px] font-light text-white/75">{t.caption}</span>
              </p>
              <a
                href={t.href}
                className={`mt-8 inline-flex h-12 items-center justify-center rounded-full text-[14px] transition-colors ${
                  t.featured ? "bg-white text-black hover:bg-white/85" : "border border-blue text-white hover:bg-blue/20"
                }`}
              >
                {t.cta}
              </a>
              <p className="mt-9 text-[15px] font-medium">What it tries</p>
              <ul className="mt-4 space-y-3.5">
                {t.items.map((item) => (
                  <li key={item} className="flex items-start gap-3 text-[14px] font-light leading-[1.4] text-soft">
                    <Icon name="check" className="mt-px size-4 shrink-0 text-white/70" />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </Container>
    </section>
  );
}
