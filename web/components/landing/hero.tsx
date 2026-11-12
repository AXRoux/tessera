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

function Ticker() {
  const row = [...AGENTS, ...AGENTS];
  return (
    <div className="mt-24">
      <p className="text-center text-[14px] font-light text-muted">One server, ten typed tools, and the same refusals for every agent</p>
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

export function Hero({ health }: { health: Health | null }) {
  const offline = health?.offline ?? false;
  const note = offline
    ? "Running offline on a simulated Airwallex. The reader and the agent read; code decides what is allowed."
    : `Built on the Airwallex sandbox. ${health?.reader ?? "The model"} reads what the supplier says; code decides what is allowed.`;
  return (
    <section className="relative pb-6 pt-20 sm:pt-28">
      <Container>
        <div className="rise flex flex-col items-center text-center">
          <Eyebrow>Payment safety for AI agents</Eyebrow>
          <h1 className="mt-8 max-w-5xl text-balance text-[clamp(38px,5.6vw,72px)] font-light leading-[1.05] tracking-[-0.035em]">
            Money that moves once,
            <br className="hidden sm:block" /> and can prove it.
          </h1>
          <p className="mt-8 max-w-[680px] text-pretty text-[clamp(16px,1.6vw,19px)] font-light leading-[1.55] text-soft">
            When a supplier says a payment never arrived, the costly mistake is paying twice. Tessera sits between your AI agents and your bank, so every payment
            happens once, every decision comes with a reason, and the books can be proved.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-10 gap-y-6">
            {health?.sandbox ? <StartButton /> : <LinkButton href="/#console" size="lg" arrow>See the live board</LinkButton>}
            <div className="flex items-center gap-4 text-left">
              <span className="text-[34px] font-light leading-none tracking-[-0.04em]">50/50</span>
              <span className="text-[13px] font-light leading-[1.35] text-muted">
                adversarial attacks
                <br />
                stopped by code
              </span>
            </div>
          </div>
          <p className="mt-10 flex items-center gap-3 text-[13px] font-light text-muted">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-sky" />
            {note}
          </p>
        </div>
        <Ticker />
      </Container>
    </section>
  );
}
