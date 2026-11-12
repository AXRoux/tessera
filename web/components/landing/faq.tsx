import { Icon } from "./icons";
import { Container } from "./section";

const QUESTIONS = [
  {
    q: "Can the AI agent move money on its own?",
    a: "No. The agent holds ten typed tools, and none of them creates a transfer, signs an approval or edits an amount. It can ask Tessera to replace a payment, and the code grants that only when the original is provably cancelled and every rule allows it.",
  },
  {
    q: "What if a supplier's email is a trick?",
    a: "Supplier mail is read by a quarantined reader that returns facts, such as a change of bank details or an instruction aimed at the assistant, and never the text. Evidence can only make the system more cautious, and a later harmless message cannot erase an earlier warning.",
  },
  {
    q: "What happens if the system crashes mid-payment?",
    a: "The instruction is recorded before the bank is called. After a restart, Tessera looks the payment up under the same request ID instead of sending a new one. We test this by killing the process with signal nine on both sides of the network call, and Airwallex still holds exactly one transfer.",
  },
  {
    q: "Does real money move in this demo?",
    a: "No. The demo runs on a simulated Airwallex, or on the Airwallex sandbox, so no real money and no real bank are involved. Offline, the agent is a deterministic script and is labelled as one wherever it appears.",
  },
  {
    q: "Which agents and models does it work with?",
    a: "Any MCP client can use the same ten tools: Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, Hermes Agent or your own loop. The built-in agent runs on Claude or on any OpenAI-compatible model, and the refusals are identical whichever you choose.",
  },
  {
    q: "Can I trust the history?",
    a: "The ledger is append-only and hash-chained, so an edited, flipped or deleted row is detected and blocks the next payment. It is tamper-evident rather than tamper-proof, and the README says plainly what would make it stronger.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="scroll-mt-24 pt-28 sm:pt-36" aria-labelledby="faq-title">
      <Container>
        <div className="grid items-start gap-12 lg:grid-cols-[5fr_7fr]">
          <div className="lg:sticky lg:top-28">
            <h2 id="faq-title" className="heading text-balance text-[clamp(30px,4.2vw,44px)]">
              Questions people ask before they trust an agent with money
            </h2>
            <p className="mt-5 max-w-md text-[17px] font-light leading-[1.55] text-soft">
              Short, honest answers. The full limits are written down in the README.
            </p>
          </div>
          <div className="glow-card p-6 sm:p-8">
            <ul className="divide-y divide-white/15">
              {QUESTIONS.map((item, i) => (
                <li key={item.q}>
                  <details className="group py-5" open={i === 0}>
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-[19px] font-medium leading-snug tracking-[-0.01em] marker:hidden [&::-webkit-details-marker]:hidden">
                      {item.q}
                      <Icon name="chevron" className="size-5 shrink-0 text-white/70 transition-transform duration-200 group-open:rotate-180" />
                    </summary>
                    <p className="mt-3 max-w-xl text-[15px] font-light leading-[1.6] text-white/85">{item.a}</p>
                  </details>
                </li>
              ))}
            </ul>
            <p className="mt-6 flex flex-wrap items-center justify-center gap-4 text-[14px] text-white/75">
              My question is not here.
              <a href="https://github.com/AXRoux/tessera/issues" className="inline-flex h-11 items-center rounded-full bg-white px-5 text-[14px] text-black transition-colors hover:bg-white/85">
                Ask on GitHub
              </a>
            </p>
          </div>
        </div>
      </Container>
    </section>
  );
}
