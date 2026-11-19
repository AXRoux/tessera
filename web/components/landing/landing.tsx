"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { initialsOf } from "@/lib/initials";
import { useSignedIn, type SignedIn } from "@/lib/use-account";
import { AuthScreen, type AuthMode } from "../auth/auth-screen";
import { LinkBtn } from "../kit/metal";
import { useTheme } from "../kit/theme";
import { Toggle } from "../kit/widgets";
import { Logo } from "../logo";
import { Icon } from "./icons";
import { PeelPage, usePeel } from "./peel";

/*
 * The landing: one 16:9 billboard, after a reference billboard (a ruled white face with a two-column headline and a
 * code to scan, beside one full-bleed duotone picture of a crowd, the mark laid over it, framed in its brightest tone)
 * and a series of grainy editorial posters. The paper face says what Tessera is. The picture face shows a person and an
 * agent walking to work together, printed as a cobalt halftone, with the wordmark over it, a market line drawing itself,
 * tracking boxes naming who signs and who acts, and one invoice being worked live. The agents it works with run
 * beneath. The picture is generated and printed by scripts/gen-landing-art.ts; nothing here is a number we cannot
 * stand behind.
 *
 * The whole wall is a sticker over the sign-in screen: lift its corner, or press a sign-in button, and it peels away
 * (components/landing/peel.tsx). The address follows (/sign-in), so Back lays the sticker down again.
 */

export interface LandingProps {
  /** Multi-tenant host: people sign up for a workspace. Otherwise the console is one operator's. */
  accounts: boolean;
  /** Where Airwallex is: the sandbox, the offline simulator, or (signed-out, multi-tenant) each person's own sandbox. */
  rail: "sandbox" | "offline" | "byok";
  /** Who the server saw signed in on this browser (multi-tenant mode), so the first paint already greets them. */
  account: SignedIn | null;
}

const AGENTS = [
  { name: "Claude Code", src: "/agents/claude.svg" },
  { name: "OpenAI Codex", src: "/agents/openai-on-dark.svg" },
  { name: "Cursor", src: "/agents/cursor-on-dark.svg" },
  { name: "Gemini CLI", src: "/agents/gemini.svg" },
  { name: "GitHub Copilot", src: "/agents/githubcopilot-on-dark.svg" },
  { name: "Hermes Agent", src: "/agents/hermes-agent-on-dark.svg", full: true },
];

/* ── Poster furniture ───────────────────────────────────────────────────────────────────────────────────────────── */

function Crosshair({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`size-5 ${className}`} fill="none" stroke="currentColor" strokeWidth="1">
      <path d="M12 0v24M0 12h24" />
      <circle cx="12" cy="12" r="5" />
    </svg>
  );
}

/** Bars drawn from a string, so the same words always print the same code. */
export function Barcode({ text, className = "" }: { text: string; className?: string }) {
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    for (let bit = 0; bit < 4; bit++) {
      const w = ((code >> bit) & 1) + 1;
      if ((code + bit) % 3 !== 0) bars.push({ x, w });
      x += w + 1.2;
    }
  }
  return (
    <svg aria-hidden viewBox={`0 0 ${x} 20`} preserveAspectRatio="none" className={className} fill="currentColor">
      {bars.map((bar, i) => (
        <rect key={i} x={bar.x} width={bar.w} height="20" />
      ))}
    </svg>
  );
}

/** The billboard's chart: a ruled grid and a market line that draws itself, holds, and moves on. */
function Chart({ className = "" }: { className?: string }) {
  const line = "M0 258 L18 226 L30 240 L48 182 L60 204 L78 146 L92 178 L110 108 L124 140 L140 90 L156 128 L172 64 L190 102 L206 50 L222 82 L240 38 L258 70 L276 26 L300 48";
  return (
    <svg aria-hidden viewBox="0 0 300 300" preserveAspectRatio="none" className={className} fill="none">
      <rect width="300" height="300" fill="rgb(2 8 56 / 0.5)" />
      <g stroke="rgb(156 200 255 / 0.36)" strokeWidth="1">
        {Array.from({ length: 13 }, (_, i) => (
          <path key={`h${i}`} d={`M0 ${i * 25}H300`} vectorEffect="non-scaling-stroke" />
        ))}
        {Array.from({ length: 11 }, (_, i) => (
          <path key={`v${i}`} d={`M${i * 30} 0V300`} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      <path d={`${line} L300 300 L0 300 Z`} fill="rgb(122 184 255 / 0.32)" />
      <path className="draw-line" pathLength={1} d={line} stroke="#eef5ff" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** A tracking box pinned to a figure in the picture, with who it is and what they do. */
function Lock({ label, verb, box, delay, warm = false }: { label: string; verb: string; box: [number, number, number, number]; delay: number; warm?: boolean }) {
  const [left, top, width, height] = box;
  const tone = warm ? "border-[#ffd27a]" : "border-white";
  return (
    <div aria-hidden className="lock-on absolute" style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%`, animationDelay: `${delay}ms` }}>
      {["left-0 top-0 border-l-2 border-t-2", "right-0 top-0 border-r-2 border-t-2", "left-0 bottom-0 border-l-2 border-b-2", "right-0 bottom-0 border-r-2 border-b-2"].map((corner) => (
        <span key={corner} className={`absolute size-[clamp(8px,1.4cqw,16px)] ${corner} ${tone}`} />
      ))}
      <span className={`micro absolute bottom-full left-0 mb-1.5 whitespace-nowrap px-1.5 py-0.5 ${warm ? "bg-[#ffd27a] text-[#020838]" : "bg-white text-[#020838]"}`}>
        {label} <span className="opacity-55">· {verb}</span>
      </span>
    </div>
  );
}

/** The mark, in one ink, with the card's stripe and its "1x" cut out so the picture shows through. */
function Mark({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 100 100" className={className}>
      <defs>
        <mask id="mark-cut">
          <rect width="100" height="100" fill="#fff" />
          <rect x="19.5" y="36.5" width="61" height="7" fill="#000" />
          <path d="M34 50.5h9v18h-5.5v-12l-3.6 2.9-2.3-4.1zM50 55.2l3.2-3.2 4.8 4.8 4.8-4.8 3.2 3.2-4.8 4.8 4.8 4.8-3.2 3.2-4.8-4.8-4.8 4.8-3.2-3.2 4.8-4.8z" fill="#000" />
        </mask>
      </defs>
      <path d="M4 4H80L96 20V96H20L4 80Z" fill="none" stroke="currentColor" strokeWidth="4" />
      <path d="M16 23H75L84 32V77H25L16 68Z" fill="currentColor" mask="url(#mark-cut)" />
    </svg>
  );
}

/* ── The door underneath ────────────────────────────────────────────────────────────────────────────────────────── */

type Door = "sign-in" | "sign-up";

/** Which screen the address asks for: the landing itself, or what is under it. */
function doorAt(pathname: string, accounts: boolean): AuthMode | null {
  if (pathname === "/sign-in") return accounts ? "sign-in" : "operator";
  if (pathname === "/sign-up" && accounts) return "sign-up";
  return null;
}

/** Peel the landing away to a door. The address changes in place (no navigation), and the peel follows the address. */
const peelTo = (door: Door) => window.history.pushState(null, "", `/${door}`);

/** A sign-in link that peels the page instead of leaving it; a modified click (new tab, new window) still navigates. */
function peelOnClick(door: Door) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    peelTo(door);
  };
}

/** Printed on the page underneath, along the fold, where a lifting corner shows it. */
function CornerHint({ word }: { word: string }) {
  return (
    <div className="absolute bottom-[50px] right-[50px] translate-x-1/2 translate-y-1/2 -rotate-45 text-center">
      <p className="micro text-fg/55">Peel to</p>
      <p className="cond text-[24px] leading-none text-accent">{word}</p>
    </div>
  );
}

/**
 * The landing. On the multi-tenant host it follows the session live: whoever is signed in on this browser is greeted
 * by name and goes straight to their control room, and signing in or out anywhere on the page shows at once.
 */
export function Landing(props: LandingProps) {
  return props.accounts ? <SessionLanding {...props} /> : <LandingView {...props} user={null} />;
}

function SessionLanding(props: LandingProps) {
  const user = useSignedIn(props.account);
  return <LandingView {...props} user={user} />;
}

function LandingView({ accounts, rail, user }: LandingProps & { user: SignedIn | null }) {
  const pathname = usePathname();
  const wanted = doorAt(pathname, accounts);
  // The last door shown stays underneath while the sheet is laid back down.
  const [door, setDoor] = useState<AuthMode>(accounts ? "sign-in" : "operator");
  useEffect(() => {
    if (wanted) setDoor(wanted);
  }, [wanted]);

  return (
    <PeelPage
      open={wanted !== null}
      onPeeled={() => peelTo("sign-in")}
      label={user ? "Peel the page away to your control room" : "Peel the page away to sign in"}
      hint={<CornerHint word={user ? "Enter" : "Sign in"} />}
      under={
        <div className="min-h-dvh xl:h-dvh xl:min-h-[640px]">
          <AuthScreen
            mode={wanted ?? door}
            next={null}
            account={user}
            onSwitch={(mode) => window.history.replaceState(null, "", `/${mode}`)}
            onHome={() => window.history.back()}
          />
        </div>
      }
    >
      <Wall accounts={accounts} rail={rail} user={user} />
    </PeelPage>
  );
}

/* ── The page ───────────────────────────────────────────────────────────────────────────────────────────────────── */

function Wall({ accounts, rail, user }: Omit<LandingProps, "account"> & { user: SignedIn | null }) {
  const { theme, setTheme } = useTheme();
  const { beckon } = usePeel();
  // A sign-in button lifts the corner while it is pointed at: this is the way in, and this is where it opens.
  const doorLink = (to: Door) => ({
    href: `/${to}`,
    onClick: peelOnClick(to),
    onPointerEnter: () => beckon(true),
    onPointerLeave: () => beckon(false),
    onFocus: () => beckon(true),
    onBlur: () => beckon(false),
  });
  const wall = useRef<HTMLDivElement>(null);

  // Pointer parallax for the poster images, written straight to CSS variables so it never re-renders the page.
  useEffect(() => {
    const el = wall.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.setProperty("--px", ((event.clientX / window.innerWidth) * 2 - 1).toFixed(3));
        el.style.setProperty("--py", ((event.clientY / window.innerHeight) * 2 - 1).toFixed(3));
      });
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      cancelAnimationFrame(frame);
    };
  }, []);

  const railLabel = rail === "offline" ? "Offline sandbox" : rail === "byok" ? "Airwallex sandbox · your keys" : "Airwallex sandbox · live";

  return (
    <div ref={wall} className="relative flex min-h-dvh flex-col overflow-hidden xl:h-dvh xl:min-h-[680px]">
      <div aria-hidden className="grain pointer-events-none absolute inset-0 z-40 opacity-[0.08] mix-blend-multiply [[data-theme=dark]_&]:opacity-[0.16] [[data-theme=dark]_&]:mix-blend-screen" />

      {/* ── Masthead ── */}
      <header className="relative z-10 flex h-[68px] shrink-0 items-center gap-6 px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Tessera home">
          <span className="tile flex size-10 items-center justify-center rounded-[12px]!">
            <Logo size={22} />
          </span>
          <span className="cond text-[22px] tracking-[0.01em]">Tessera</span>
        </Link>
        <nav aria-label="Site" className="micro hidden items-center gap-6 text-fg/60 md:flex">
          <Link href="/dashboard" className="hover:text-fg">
            <span className="text-accent">01</span> Control room
          </Link>
          <Link href="/queue" className="hover:text-fg">
            <span className="text-accent">02</span> The queue
          </Link>
          <a href="https://github.com/AXRoux/tessera/blob/main/SPEC.md" className="hover:text-fg">
            <span className="text-accent">03</span> Specification
          </a>
          <a href="https://github.com/AXRoux/tessera" className="hover:text-fg">
            <span className="text-accent">04</span> Source
          </a>
          <Link href="/terms" className="hidden hover:text-fg lg:inline-flex lg:items-center lg:gap-2">
            <span className="text-accent">05</span> Terms
          </Link>
          <Link href="/privacy" className="hidden hover:text-fg lg:inline-flex lg:items-center lg:gap-2">
            <span className="text-accent">06</span> Privacy
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="micro well hidden h-8 items-center gap-2 rounded-full! px-3 text-fg/70 lg:inline-flex">
            <span aria-hidden className="beat size-1.5 rounded-full bg-accent" />
            {railLabel}
          </span>
          <Toggle
            label="Appearance"
            value={theme}
            onChange={setTheme}
            options={[
              { id: "light", label: <Icon name="sun" className="size-4" />, title: "Light" },
              { id: "dark", label: <Icon name="moon" className="size-4" />, title: "Dark" },
            ]}
          />
          {user ? (
            // Signed in: their name, not a request to sign in again. It peels to their card and the way back in.
            <LinkBtn
              tone="secondary"
              {...doorLink("sign-in")}
              className="pl-1.5!"
              icon={
                <span aria-hidden className="tile inverse flex size-6 items-center justify-center rounded-full! text-[10px] font-semibold text-fg">
                  {initialsOf(user.name || user.email)}
                </span>
              }
            >
              <span className="max-w-[140px] truncate">{user.name.trim().split(/\s+/)[0] || user.email}</span>
            </LinkBtn>
          ) : (
            <LinkBtn tone="secondary" {...doorLink("sign-in")}>
              Sign in
            </LinkBtn>
          )}
        </div>
      </header>

      {/* ── The billboard: a ruled paper face, and one printed picture with the mark laid over it ── */}
      <main className="relative z-10 min-h-0 flex-1 px-5 sm:px-8">
        <div className="grid h-full min-h-0 overflow-hidden rounded-[18px] shadow-[0_40px_80px_-44px_rgb(4_16_90/0.7),0_2px_0_rgb(255_255_255/0.5)_inset] xl:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)]">
          {/* The paper face */}
          <section className="paper-face @container relative flex min-h-0 flex-col px-[clamp(20px,2.1vw,34px)] pb-[clamp(16px,1.6vw,24px)] pt-[clamp(16px,1.6vw,24px)]">
            <div aria-hidden className="grain pointer-events-none absolute inset-0 opacity-[0.07] mix-blend-multiply [[data-theme=dark]_&]:mix-blend-screen" />
            {/* The corner the billboard turns: the paper darkens a touch toward the seam. */}
            <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-[linear-gradient(90deg,transparent,rgb(4_16_90/0.07))]" />

            <h1 className="cond relative my-auto grid py-[clamp(18px,4vh,48px)] grid-cols-[auto_1fr] gap-x-[0.42em] whitespace-nowrap text-[clamp(34px,13.4cqw,150px)]">
              <span className="cond-in relative -top-[0.4em]" style={{ animationDelay: "0ms" }}>
                The
                <br />
                agentic
              </span>
              <span className="cond-in text-accent" style={{ animationDelay: "120ms" }}>
                Treasury
                <br />
                ops
                <br />
                platform.
              </span>
            </h1>

            <div className="relative grid grid-cols-[1.15fr_1fr] border-t border-[var(--rule)] shorter:grid-cols-1">
              <p className="py-[clamp(10px,1.3vw,18px)] pr-5 text-[clamp(12.5px,min(0.92vw,1.6vh),15px)] leading-relaxed opacity-80 shorter:hidden">
                Tessera is the control layer between your AI agents and your treasury. Agents act, policy decides, people sign.
              </p>
              <div className="flex flex-col justify-center gap-2 border-l border-[var(--rule)] py-[clamp(10px,1.3vw,18px)] pl-5 shorter:flex-row shorter:border-l-0 shorter:pb-0 shorter:pl-0">
                {accounts && !user ? (
                  <>
                    <LinkBtn size="md" block {...doorLink("sign-up")} icon={<Icon name="wallet" className="size-4" />}>
                      Get your card
                    </LinkBtn>
                    <LinkBtn size="md" block tone="secondary" {...doorLink("sign-in")}>
                      Sign in
                    </LinkBtn>
                  </>
                ) : (
                  <>
                    <LinkBtn size="md" block href="/dashboard" icon={<Icon name="dashboard" className="size-4" />}>
                      Open the control room
                    </LinkBtn>
                    <LinkBtn size="md" block tone="secondary" href="/dashboard?compose=1">
                      Send a payout
                    </LinkBtn>
                  </>
                )}
              </div>
            </div>
          </section>

          {/* The picture face: people and an agent on their way to work, printed in cobalt, framed in its brightest tone. */}
          <figure className="picture-face relative min-h-[440px] p-[clamp(6px,0.62vw,10px)] xl:min-h-0">
            <div className="cover-box relative h-full overflow-hidden bg-[#020838] text-white">
              <div className="cover-fit absolute left-1/2 top-1/2 [translate:-57%_-52%]">
                <Image
                  src="/landing/billboard.webp"
                  alt="A woman and a humanoid robot walk side by side into a crowd of office workers in a financial district"
                  fill
                  unoptimized
                  priority
                  sizes="(min-width: 1280px) 62vw, 100vw"
                  className="object-cover"
                />
                {/* The two it is about: the person who signs, and the agent that acts. */}
                <Lock label="Person" verb="signs" box={[39.5, 58.5, 11.2, 38.5]} delay={600} warm />
                <Lock label="Agent" verb="acts" box={[51.2, 50, 12, 47]} delay={1500} />
              </div>
              <div aria-hidden className="grain pointer-events-none absolute inset-0 opacity-30 mix-blend-overlay" />
              <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgb(2_8_56/0.5)_0%,transparent_34%,transparent_70%,rgb(2_8_56/0.55)_100%)]" />
              {/* The corner again: the picture falls into shade where it meets the paper. */}
              <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-14 bg-[linear-gradient(90deg,rgb(2_8_56/0.5),transparent)]" />

              <Chart className="absolute right-0 top-0 h-[50%] w-[36%] [mask-image:linear-gradient(225deg,#000_58%,transparent_94%)]" />

              <div className="drift-over absolute left-[5%] top-[9%] flex items-center gap-[0.16em] text-[clamp(44px,11.6cqw,200px)] leading-none drop-shadow-[0_4px_22px_rgb(2_8_56/0.55)]">
                <Mark className="size-[0.86em] shrink-0" />
                <span className="select-none pb-[0.06em] font-bold tracking-[-0.08em]">Tessera.</span>
              </div>

              <p className="micro absolute bottom-[4%] left-[4%] hidden text-white/80 sm:block">
                Human + agent
                <br />
                One ledger
              </p>
              <Crosshair className="absolute right-[4%] top-[54%] hidden size-5 text-white/70 sm:block" />
            </div>
          </figure>
        </div>
      </main>

      {/* ── Beneath the billboard: the agents it works with, and who made it ── */}
      <footer className="relative z-10 flex h-[clamp(48px,7vh,64px)] shrink-0 items-center gap-6 px-5 sm:px-8">
        <p className="micro shrink-0 text-fg/55">
          Works with the agents
          <br />
          you already use
        </p>
        <div className="relative min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]">
          <ul className="marquee flex w-max items-center gap-10 pr-10">
            {[...AGENTS, ...AGENTS].map((agent, i) => (
              <li key={`${agent.name}-${i}`} aria-hidden={i >= AGENTS.length} className="flex shrink-0 items-center gap-2.5">
                <span className="flex size-8 items-center justify-center overflow-hidden rounded-[10px] bg-[#0c0d10] shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]">
                  <Image src={agent.src} alt="" width={32} height={32} unoptimized className={agent.full ? "size-8" : "size-4 object-contain"} />
                </span>
                <span className="cond text-[20px] text-fg/85">{agent.name}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="micro hidden shrink-0 items-center gap-6 pr-12 text-right text-fg/55 lg:flex">
          <a href="https://www.null-ptr.team" target="_blank" rel="noopener noreferrer" className="group transition-colors hover:text-fg">
            <span className="block">Created by Vance Poitier,</span>
            <span className="block">
              Captain of <span className="text-accent underline decoration-accent/40 underline-offset-[3px] group-hover:decoration-accent">NULL* Team</span>
              <span aria-hidden className="ml-1 inline-block transition-transform group-hover:-translate-y-px group-hover:translate-x-px">↗</span>
            </span>
          </a>
          <p>
            <span className="block">{rail === "offline" ? "Simulated Airwallex" : "Airwallex sandbox"} · no real money</span>
          </p>
        </div>
      </footer>
    </div>
  );
}
