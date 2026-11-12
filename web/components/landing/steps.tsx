import { Icon, type IconName } from "./icons";
import { Container, SectionHead } from "./section";

const STEPS: { n: number; icon: IconName; title: string; body: string }[] = [
  {
    n: 1,
    icon: "mail",
    title: "Hear the problem",
    body: "A supplier says the money never arrived, or the bank reports a failure. Tessera opens an incident and reads the supplier's message through the quarantined reader.",
  },
  {
    n: 2,
    icon: "scale",
    title: "Decide, safely",
    body: "Tessera recommends one move and shows its working. The agent acts only through ten typed tools, and the code decides what each of them is allowed to do.",
  },
  {
    n: 3,
    icon: "badge",
    title: "Prove it",
    body: "Once the hold window passes, Tessera checks every wallet line against Airwallex and signs a certificate. If the bank returns the money later, the certificate is revoked.",
  },
];

export function Steps() {
  return (
    <section id="how" className="scroll-mt-24 pt-28 sm:pt-36" aria-labelledby="steps">
      <Container>
        <SectionHead center id="steps" title="From a worried supplier to a signed record">
          Every incident follows the same three steps, so you always know where you are and what happens next.
        </SectionHead>
        <ol className="mt-16 grid gap-6 md:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="glow-card flex min-h-[360px] flex-col justify-between p-8">
              <span aria-hidden className="numeral pointer-events-none absolute -right-3 top-4 select-none text-[300px]">
                {s.n}
              </span>
              <span className="relative inline-flex size-11 items-center justify-center text-white">
                <Icon name={s.icon} className="size-9" />
              </span>
              <div className="relative">
                <h3 className="text-[22px] font-medium tracking-[-0.02em]">
                  <span className="sr-only">Step {s.n}: </span>
                  {s.title}
                </h3>
                <p className="mt-3 text-[15px] font-light leading-[1.55] text-white/90">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
