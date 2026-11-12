import Image from "next/image";
import type { Health } from "../../../src/server/wire";
import { StartButton } from "../tour";
import { Eyebrow, LinkButton } from "../ui";
import { Container } from "./section";

const AGENTS = [
  { name: "Claude Code", src: "/agents/claude.svg" },
  { name: "OpenAI Codex", src: "/agents/openai-on-dark.svg" },
  { name: "Cursor", src: "/agents/cursor-on-dark.svg" },
  { name: "Gemini CLI", src: "/agents/gemini.svg" },
  { name: "GitHub Copilot", src: "/agents/githubcopilot-on-dark.svg" },
  { name: "Hermes Agent", src: "/agents/hermes-agent-on-dark.svg" },
];

/** The agents that already speak MCP, scrolling past on a loop. */
function Ticker() {
  const row = [...AGENTS, ...AGENTS];
  return (
    <div className="mt-24">
      <p className="mx-auto max-w-xl text-balance text-center text-[14px] font-light leading-relaxed text-muted">
        Works with the agents you already use. One server, ten tools, and the same safeguards for every one of them.
      </p>
      <div className="relative mt-8 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_14%,#000_86%,transparent)]">
        <ul className="marquee flex w-max items-center gap-16 pr-16">
          {row.map((agent, i) => (
            <li key={`${agent.name}-${i}`} aria-hidden={i >= AGENTS.length} className="flex shrink-0 items-center gap-3 text-[20px] font-medium tracking-[-0.03em] text-white/85">
              <Image src={agent.src} alt="" width={30} height={30} unoptimized className="size-[30px] object-contain" />
              {agent.name}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The real incident page, framed like a window and fading into the page, so the first thing you see is the product. */
function ProductVisual() {
  return (
    <div className="mx-auto mt-16 w-full max-w-[1040px]">
      <div className="overflow-hidden rounded-[22px] border border-white/[0.12] bg-surface [mask-image:linear-gradient(180deg,#000_62%,transparent_100%)]">
        <div className="flex items-center gap-2 border-b border-white/[0.08] px-5 py-3.5">
          <span aria-hidden className="size-2.5 rounded-full bg-white/20" />
          <span aria-hidden className="size-2.5 rounded-full bg-white/20" />
          <span aria-hidden className="size-2.5 rounded-full bg-white/20" />
          <span className="ml-4 text-[12px] font-light text-muted">tessera / incidents / ACME-1044</span>
        </div>
        <Image
          src="/screens/incident.png"
          alt="The Tessera incident page for a supplier who asked to change bank details: handed to a person, with the recommendation and the actions that are blocked."
          width={1440}
          height={800}
          priority
          unoptimized
          className="h-auto w-full"
        />
      </div>
    </div>
  );
}

export function Hero({ health }: { health: Health | null }) {
  const offline = health?.offline ?? false;
  const note = offline
    ? "Running offline on a simulated Airwallex. The reader and the agent read; code decides what is allowed."
    : `Built on the Airwallex sandbox. ${health?.reader ?? "The model"} reads what the supplier says; code decides what is allowed.`;
  return (
    <section className="relative pb-6 pt-20 sm:pt-28">
      <Container>
        <div className="rise flex flex-col items-center text-center">
          <Eyebrow>For finance teams that let AI agents near their payments</Eyebrow>
          <h1 className="mt-8 max-w-5xl text-balance text-[clamp(38px,5.6vw,72px)] font-light leading-[1.05] tracking-[-0.035em]">
            Money that moves once,
            <br className="hidden sm:block" /> and can prove it.
          </h1>
          <p className="mt-8 max-w-[700px] text-pretty text-[clamp(16px,1.6vw,19px)] font-light leading-[1.6] text-soft">
            Your agent reads the email and does the legwork. Tessera makes sure a payment can only ever happen once, that every decision comes with a reason, and that a
            person is called in the moment the stakes are real.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            {health?.sandbox ? <StartButton /> : <LinkButton href="/#console" size="lg" arrow>See the live board</LinkButton>}
            <LinkButton href="/#how" variant="secondary" size="lg">
              See how it works
            </LinkButton>
          </div>
          <p className="mt-8 flex items-center gap-3 text-[13px] font-light text-muted">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-sky" />
            {note}
          </p>
        </div>
        <ProductVisual />
        <Ticker />
      </Container>
    </section>
  );
}
