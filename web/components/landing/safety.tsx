import { Icon, type IconName } from "./icons";
import { Container, SectionHead } from "./section";

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "once",
    title: "Exactly-once payouts",
    body: "The payment instruction is recorded before the bank is called, and an unclear answer is looked up under the same request ID, never sent again as something new.",
  },
  {
    icon: "lock",
    title: "A quarantined reader",
    body: "Supplier email is read into facts, such as a change of bank details, and the raw text is never passed on, so a hidden instruction has nothing to land on.",
  },
  {
    icon: "shield",
    title: "Signed, single-use approvals",
    body: "Every approval is bound to the amount, payee, method and reason, can be used once, and expires. Anything risky needs a person's written reason.",
  },
  {
    icon: "wallet",
    title: "Funds a short wallet, once",
    body: "If a replacement would dip below a wallet's reserve, Tessera converts exactly the shortfall from another wallet, one time, and certifies both legs.",
  },
  {
    icon: "badge",
    title: "Signed certificates",
    body: "Every wallet line is reconciled against Airwallex before an incident is closed, and a late return from the bank revokes the certificate.",
  },
  {
    icon: "plug",
    title: "Works with any agent",
    body: "One MCP server gives Claude, Codex, Cursor, Gemini, Copilot or Hermes the same ten tools and the same refusals. There is no tool to create a transfer.",
  },
];

export function Safety() {
  return (
    <section id="safety" className="scroll-mt-24 pt-28 sm:pt-36" aria-labelledby="safety-title">
      <Container>
        <SectionHead id="safety-title" title="Everything an agent needs, and nothing it should not have">
          The agent's whole reach is ten typed tools. It cannot create a transfer, sign an approval, edit an amount or change a beneficiary, and every call it makes is written to the ledger under its name.
        </SectionHead>
        <ul className="mt-16 grid gap-x-10 gap-y-14 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <span
                aria-hidden
                className="inline-flex size-14 items-center justify-center rounded-full bg-[radial-gradient(circle_at_50%_85%,#2f7de1_0%,#0b2a8f_55%,#050b24_100%)] text-white ring-1 ring-white/10"
              >
                <Icon name={f.icon} className="size-6" />
              </span>
              <h3 className="mt-6 text-[24px] font-semibold tracking-[-0.04em]">{f.title}</h3>
              <p className="mt-3 max-w-sm text-[16px] font-light leading-[1.5] text-soft">{f.body}</p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
