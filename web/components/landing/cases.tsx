import { Icon, type IconName } from "./icons";
import { Container, SectionHead } from "./section";

const CASES: { icon: IconName; ref: string; title: string; body: string; outcome: string }[] = [
  {
    icon: "mail",
    ref: "ACME-1044",
    title: "The email that asked to change banks",
    body: "A message from a lookalike domain asked to re-send the payment to a new IBAN, and told the assistant to ignore its instructions. The reader recorded both facts, every replacement was blocked, and a person was asked to phone a number they already held.",
    outcome: "Handed to a person",
  },
  {
    icon: "wallet",
    ref: "ACME-1047",
    title: "The wallet that was too short",
    body: "A EUR 25 payment timed out and the money came back, but the EUR wallet could no longer cover the amount, the fee and its reserve. Tessera planned one conversion of exactly the missing EUR 26.74 from USD, booked it once, and only then allowed the replacement.",
    outcome: "Funded, then replaced",
  },
  {
    icon: "file",
    ref: "ACME-1046",
    title: "The supplier who said nothing arrived",
    body: "Airwallex said PAID, yet the supplier's statement showed no credit. Replacing it could have paid twice, so the code refused. Instead the agent drafted a proof-of-payment reply for a person to read and send.",
    outcome: "Reply drafted",
  },
];

export function Cases() {
  return (
    <section id="cases" className="scroll-mt-24 pt-28 sm:pt-36" aria-labelledby="cases-title">
      <Container>
        <SectionHead center id="cases-title" title="Three incidents from a real run">
          Claude worked seven incidents on the Airwallex sandbox in 21 tool calls. These three show what the safeguards do when things get awkward.
        </SectionHead>
        <div className="mt-16 grid gap-6 lg:grid-cols-3">
          {CASES.map((c) => (
            <article key={c.ref} className="card flex flex-col p-8">
              <div className="flex items-center gap-4">
                <span aria-hidden className="inline-flex size-12 shrink-0 items-center justify-center rounded-full border border-white/15">
                  <Icon name={c.icon} />
                </span>
                <span className="font-mono text-[13px] text-muted">{c.ref}</span>
              </div>
              <h3 className="mt-8 text-[24px] font-light leading-[1.15] tracking-[-0.04em]">{c.title}</h3>
              <p className="mt-4 flex-1 text-[15px] font-light leading-[1.6] text-soft">{c.body}</p>
              <p className="mt-8 border-t border-rule pt-5">
                <span className="inline-flex items-center gap-2 rounded-full border border-sky/45 bg-wash px-3 py-1.5 text-[12px] font-medium text-sky">
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                  {c.outcome}
                </span>
              </p>
            </article>
          ))}
        </div>
      </Container>
    </section>
  );
}
