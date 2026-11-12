import { Icon, type IconName } from "./icons";
import { Container, SectionHead } from "./section";

const MISTAKES: { icon: IconName; title: string; body: React.ReactNode }[] = [
  {
    icon: "once",
    title: "Replace too early",
    body: "The first transfer is still on its way. Send another and the supplier has been paid twice.",
  },
  {
    icon: "mail",
    title: "Trust the email",
    body: (
      <>
        A message says &ldquo;we changed banks.&rdquo; Follow it and you have paid a fraudster. Business email compromise cost{" "}
        <a
          href="https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf"
          className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white"
        >
          $3.05 billion in reported losses in 2025
        </a>
        .
      </>
    ),
  },
  {
    icon: "badge",
    title: "Trust the bank",
    body: "A bank says PAID. It can still send the money back days later, so paid is a claim, not a fact.",
  },
];

export function Problem() {
  return (
    <section className="pt-28 sm:pt-36" aria-labelledby="problem">
      <Container>
        <SectionHead id="problem" title="A supplier says the money never arrived. What should your agent do?">
          It has three answers: wait, replace, or hand it to a person. Every wrong one costs real money, and an agent holding raw payment credentials can make all three mistakes quickly and with confidence.
        </SectionHead>
        <ol className="mt-14 grid gap-6 md:grid-cols-3">
          {MISTAKES.map((m, i) => (
            <li key={m.title} className="card flex flex-col p-8">
              <div className="flex items-center justify-between">
                <span className="inline-flex size-12 items-center justify-center rounded-full border border-white/15 text-white">
                  <Icon name={m.icon} />
                </span>
                <span className="text-[13px] font-light text-muted">Mistake {i + 1}</span>
              </div>
              <h3 className="mt-10 text-[26px] font-light tracking-[-0.04em]">{m.title}</h3>
              <p className="mt-4 text-[15px] font-light leading-[1.6] text-soft">{m.body}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
