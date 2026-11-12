import { Container, SectionHead } from "./section";

/** A miniature of the incident page's attempts list, to show the one-open-payment rule at work. */
function AttemptsPreview() {
  const rows = [
    { n: "01", text: "Bank timeout, money returned", tag: "Cancelled", style: "bg-black text-white" },
    { n: "02", text: "Replacement sent", tag: "Processing", style: "border border-[#4f4ff1] text-[#4f4ff1]" },
    { n: "03", text: "A second open payment", tag: "Refused", style: "bg-[#ffe1e4] text-[#b3202f]" },
  ];
  return (
    <div aria-hidden className="mt-auto translate-y-2 rounded-t-[16px] bg-white p-5 text-black shadow-[0_-20px_60px_-30px_rgb(255_255_255/0.4)]">
      <p className="text-[14px] font-semibold tracking-[-0.01em]">Payment attempts &middot; ACME-1042</p>
      <ul className="mt-4 space-y-2.5">
        {rows.map((r) => (
          <li key={r.n} className="flex items-center justify-between gap-3 rounded-xl bg-[#f3f4f8] px-3.5 py-3">
            <span className="flex items-center gap-3 text-[13px]">
              <span className="font-mono text-[12px] text-black/50">{r.n}</span>
              {r.text}
            </span>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${r.style}`}>{r.tag}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 pb-6 text-[12px] text-black/55">The database refuses the third. Nobody has to ask it to.</p>
    </div>
  );
}

/** A miniature of the recommendation card: the decision, what is safe, and what is blocked and why. */
function DecisionPreview() {
  return (
    <div aria-hidden className="mt-auto translate-y-2 rounded-t-[16px] bg-white p-5 text-black shadow-[0_-20px_60px_-30px_rgb(255_255_255/0.4)]">
      <p className="text-[12px] text-black/55">Recommended next step</p>
      <p className="mt-1 text-[30px] font-light leading-[1.05] tracking-[-0.04em]">Hand to a person</p>
      <div className="mt-3 flex gap-2">
        <span className="rounded-full bg-[#4f4ff1] px-2.5 py-1 text-[11px] font-medium text-white">Hand off</span>
        <span className="rounded-full border border-black/25 px-2.5 py-1 text-[11px] font-medium">Wait</span>
      </div>
      <p className="mt-4 text-[12px] font-medium">Not allowed, and why</p>
      <p className="mt-1.5 rounded-xl bg-[#f3f4f8] px-3.5 py-3 pb-8 text-[12px] leading-[1.5] text-black/70">
        <span className="font-medium text-black">Replace.</span> New bank details arrived by message and have not been verified.
      </p>
    </div>
  );
}

export function Idea() {
  return (
    <section id="how" className="scroll-mt-24 pt-28 sm:pt-36" aria-labelledby="idea">
      <Container>
        <SectionHead id="idea" title="Let the model read. Let the code decide.">
          An agent is wonderful at reading a messy email and sensing that something is off. It is a poor thing to trust with a wire transfer. So Tessera divides the work along that line: the model reads and explains, and a small amount of plain, tested code decides what is allowed.
        </SectionHead>
        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          <article className="card flex min-h-[420px] flex-col lg:min-h-[520px] overflow-hidden px-6 pt-8">
            <h3 className="text-[26px] font-light leading-[1.15] tracking-[-0.04em]">One open payment per invoice</h3>
            <p className="mt-4 text-[14px] font-light leading-[1.55] text-soft">
              A retry, a crash or an eager agent cannot pay twice, because the rule lives in the database and not in a prompt.
            </p>
            <AttemptsPreview />
          </article>
          <article className="card flex min-h-[420px] flex-col lg:min-h-[520px] overflow-hidden px-6 pt-8">
            <h3 className="text-[26px] font-light leading-[1.15] tracking-[-0.04em]">Risky calls go to a person</h3>
            <p className="mt-4 text-[14px] font-light leading-[1.55] text-soft">
              A change of bank details, a possible duplicate or a compliance hold is handed over with the reasons and every action that was blocked.
            </p>
            <DecisionPreview />
          </article>
          <article className="glow-card flex min-h-[420px] flex-col lg:min-h-[520px] justify-between p-8">
            <span className="glass inline-flex w-fit px-3 py-1.5 text-[13px]">Proven, not promised</span>
            <div>
              <p className="tnum text-[clamp(56px,5.4vw,80px)] font-light leading-none tracking-[-0.06em]">50/50</p>
              <p className="mt-6 text-[15px] font-light leading-[1.55] text-white/90">
                Fifty adversarial attacks, 530 tests, and 94 guards removed one at a time to prove that something notices. Every move the agent tried was refused by code.
              </p>
            </div>
          </article>
        </div>
      </Container>
    </section>
  );
}
