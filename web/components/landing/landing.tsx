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
 * The landing: one 16:9 poster wall, after the Swiss/brutalist reference. A text poster says what Tessera is; four
 * image posters say how a payout travels (agents act, code decides, a person signs, the ledger proves); the agents it
 * works with run beneath; the wordmark closes the page. Nothing here is a screenshot or a number we cannot stand behind.
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
function Barcode({ text, className = "" }: { text: string; className?: string }) {
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

function Ruler({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`micro ${className}`}>
      <div className="flex justify-between">
        <span>0</span>
        <span>50</span>
        <span>100</span>
      </div>
      <div className="relative mt-1 h-2 border-t border-current">
        {Array.from({ length: 11 }, (_, i) => (
          <span key={i} className={`absolute top-0 w-px bg-current ${i % 5 === 0 ? "h-2" : "h-1"}`} style={{ left: `${i * 10}%` }} />
        ))}
      </div>
    </div>
  );
}

/** Three interlocking rings, the reference's emblem, as Tessera's three parties: agent, code, person. */
function Rings({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 64 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="16" cy="12" r="10" />
      <circle cx="32" cy="12" r="10" />
      <circle cx="48" cy="12" r="10" />
    </svg>
  );
}

/* ── The image posters ──────────────────────────────────────────────────────────────────────────────────────────── */

function Poster({
  n,
  src,
  alt,
  title,
  lines,
  stagger,
  delay,
  children,
}: {
  n: string;
  src: string;
  alt: string;
  title: [string, string];
  lines: string[];
  stagger: "up" | "down";
  delay: number;
  children?: ReactNode;
}) {
  return (
    <article
      className={`group relative min-h-[460px] overflow-hidden rounded-[24px] bg-[#050506] text-white shadow-[0_30px_60px_-34px_rgb(0_0_0/0.7)] transition-transform duration-500 ease-out hover:-translate-y-2 xl:min-h-0 ${
        stagger === "down" ? "xl:mt-10" : "xl:mb-10"
      }`}
    >
      <Image src={src} alt={alt} fill unoptimized priority sizes="(min-width: 1280px) 22vw, 50vw" className="drift-img object-cover opacity-90 transition-opacity duration-500 group-hover:opacity-100" />
      <div aria-hidden className="grain absolute inset-0 opacity-40 mix-blend-overlay" />
      <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgb(0_0_0/0.72)_0%,transparent_34%,transparent_58%,rgb(0_0_0/0.82)_100%)]" />

      <div className="relative flex h-full flex-col justify-between p-5">
        <header className="flex items-start justify-between gap-3">
          <h3 className="cond cond-in text-[clamp(30px,min(2.6vw,4.6vh),52px)] transition-[font-variation-settings] duration-500 group-hover:[font-variation-settings:'wdth'_78]" style={{ animationDelay: `${delay}ms` }}>
            {title[0]}
            <br />
            {title[1]}
          </h3>
          <span className="cond text-[26px] leading-none text-white/90">{n}</span>
        </header>
        <div className="flex items-end justify-between gap-3">
          <div className="micro space-y-0.5 text-white/80">
            {lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <Crosshair className="shrink-0 text-white/70 transition-transform duration-700 group-hover:rotate-90" />
        </div>
        {children}
      </div>
    </article>
  );
}

/** The ledger's real habit, done live in the browser: each line is hashed together with the one before it. */
const SEALS = ["Intent sealed", "Airwallex accepts", "Status re-read", "Hold window", "Lines tie out"];

function useChain(): string[] {
  const [hashes, setHashes] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: string[] = [];
      let previous = "genesis";
      for (const line of SEALS) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${previous}|${line}`));
        previous = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        out.push(previous);
      }
      if (alive) setHashes(out);
    })();
    return () => {
      alive = false;
    };
  }, []);
  return hashes;
}

function Chain() {
  const hashes = useChain();
  const [lit, setLit] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setLit((n) => (n + 1) % (SEALS.length + 2)), 1100);
    return () => clearInterval(timer);
  }, []);
  return (
    <ol className="micro mt-auto mb-4 space-y-1.5 rounded-[14px] bg-black/55 p-3 backdrop-blur-md" aria-label="How a payout is sealed">
      {SEALS.map((line, i) => (
        <li key={line} className={`flex items-baseline justify-between gap-2 transition-colors duration-500 ${i < lit ? "text-white" : "text-white/30"}`}>
          <span className="truncate">
            <span className={i < lit ? "text-[#6fa8ff]" : ""}>{String(i + 1).padStart(2, "0")}</span> {line}
          </span>
          <span className="hidden shrink-0 text-white/45 2xl:inline">{hashes[i] ? `${hashes[i]!.slice(0, 6)}` : "······"}</span>
        </li>
      ))}
    </ol>
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

  const railLabel = rail === "offline" ? "Offline rehearsal" : rail === "byok" ? "Airwallex sandbox · your keys" : "Airwallex sandbox · live";

  return (
    <div ref={wall} className="relative flex min-h-dvh flex-col overflow-hidden xl:h-dvh xl:min-h-[680px]">
      <div aria-hidden className="grain pointer-events-none absolute inset-0 z-40 opacity-[0.14] mix-blend-multiply [[data-theme=dark]_&]:opacity-[0.22] [[data-theme=dark]_&]:mix-blend-screen" />

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

      {/* ── The wall ── */}
      <main className="relative z-10 grid min-h-0 flex-1 gap-4 px-5 sm:px-8 xl:grid-cols-[minmax(0,0.94fr)_minmax(0,1.6fr)]">
        {/* The text poster */}
        <section className="tile relative flex min-h-0 flex-col overflow-hidden rounded-[28px]! p-6 xl:p-8">
          {/* The glow and grain sit in their own rounded clip: Safari lets a blurred layer escape a rounded overflow. */}
          <div aria-hidden className="pointer-events-none absolute inset-0 [clip-path:inset(0_round_28px)]">
            <div className="absolute inset-y-0 right-0 w-[46%] bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--accent)_16%,transparent)_55%,color-mix(in_oklab,var(--accent)_62%,transparent))] blur-2xl" />
            <div className="grain absolute inset-0 opacity-25 mix-blend-multiply [[data-theme=dark]_&]:mix-blend-screen" />
          </div>

          <div className="micro relative flex items-start justify-between text-fg/60">
            <p>
              Agentic payout control
              <br />
              for finance teams
              <br />
              built on Airwallex
            </p>
            <p className="text-right">
              N°01
              <br />
              v.02 · 2026
            </p>
          </div>

          <h1 className="cond relative mt-6 text-[clamp(54px,min(5.5vw,9.2vh),112px)] text-fg xl:mt-auto">
            <span className="cond-in block" style={{ animationDelay: "0ms" }}>
              AI agents
            </span>
            <span className="cond-in block" style={{ animationDelay: "90ms" }}>
              you can trust
            </span>
            <span className="cond-in block text-accent" style={{ animationDelay: "180ms" }}>
              with payouts
            </span>
          </h1>

          <p className="relative mt-5 max-w-[520px] text-[clamp(14px,min(1vw,1.7vh),16.5px)] leading-relaxed text-fg/70 shorter:line-clamp-3">
            Tessera is the control layer between your AI agents and your treasury. Agents read the inbox, chase failed payouts, draft the replies and buy only what a person signed for, on single-use Visa cards. Policy written in
            code decides what may move, a person signs what matters, and every payout is sealed before it is sent and proved after it lands.
          </p>

          <div className="relative mt-5 grid grid-cols-[auto_auto_1fr] items-end gap-6 short:hidden">
            <ul className="micro space-y-0.5 text-fg/80" aria-label="What Tessera does">
              {["Detect.", "Decide.", "Delegate.", "Settle.", "Prove."].map((verb) => (
                <li key={verb}>{verb}</li>
              ))}
            </ul>
            <div className="micro space-y-0.5 text-fg/55">
              <p>api.sandbox.airwallex.com</p>
              <p>MCP · 13 typed tools</p>
              <p>sha-256 hash chain</p>
              <p>Visa cards · TAP-signed</p>
              <p>any model, your key</p>
            </div>
            <Ruler className="mb-1 hidden max-w-[150px] justify-self-end text-fg/45 2xl:block" />
          </div>

          <div className="relative mt-6 flex flex-wrap items-center gap-3 short:mt-4">
            {accounts && !user ? (
              <>
                <LinkBtn size="md" {...doorLink("sign-up")} icon={<Icon name="wallet" className="size-4" />}>
                  Get your card
                </LinkBtn>
                <LinkBtn size="md" tone="secondary" {...doorLink("sign-in")}>
                  Sign in
                </LinkBtn>
              </>
            ) : (
              <>
                <LinkBtn size="md" href="/dashboard" icon={<Icon name="dashboard" className="size-4" />}>
                  Open the control room
                </LinkBtn>
                <LinkBtn size="md" tone="secondary" href="/dashboard?compose=1">
                  Send a payout
                </LinkBtn>
              </>
            )}
          </div>

          <dl className="relative mt-6 grid grid-cols-3 gap-2 short:hidden">
            {[
              ["50/50", "attacks held by code"],
              ["94/94", "mutations caught by tests"],
              ["1", "live payout per invoice, max"],
            ].map(([value, label]) => (
              <div key={label} className="well rounded-[14px]! px-3 py-2.5">
                <dt className="cond text-[26px] leading-none">{value}</dt>
                <dd className="micro mt-1 text-fg/55">{label}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* The image posters: how a payout travels */}
        <section aria-label="How a payout travels" className="grid min-h-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Poster
            n="01"
            src="/landing/agents.webp"
            alt="A chrome robotic hand reaching for a point of light"
            title={["Agents", "act."]}
            lines={["Thirteen typed tools", "Any model, over MCP", "Pays with Visa, signed by TAP"]}
            stagger="up"
            delay={220}
          />
          <Poster
            n="02"
            src="/landing/code.webp"
            alt="A wave of iridescent liquid chrome"
            title={["Code", "decides."]}
            lines={["Policy in code,", "not in prompts.", "50 attacks. 50 held."]}
            stagger="down"
            delay={300}
          >
            <Rings className="absolute right-5 top-[42%] h-6 text-white/70" />
          </Poster>
          <Poster
            n="03"
            src="/landing/human.webp"
            alt="A woman in profile, eyes closed, in black and white"
            title={["Humans", "sign."]}
            lines={["In the loop", "In writing", "By name"]}
            stagger="up"
            delay={380}
          >
            <div className="tile absolute bottom-16 right-5 w-[46%] rounded-[16px]! p-3 text-fg">
              <p className="cond text-[22px] leading-none">You decide</p>
              <p className="micro mt-1.5 text-fg/60">Nothing moves until a named person signs.</p>
            </div>
          </Poster>
          <Poster
            n="04"
            src="/landing/proof.webp"
            alt="Black glass mosaic tiles, one glowing electric blue"
            title={["Proof,", "sealed."]}
            lines={["Each line hashed", "to the one before"]}
            stagger="down"
            delay={460}
          >
            <div className="absolute inset-x-5 top-[30%]">
              <Chain />
              <Barcode text="TESSERA-PROOF-0001" className="h-7 w-full text-white/80" />
            </div>
          </Poster>
        </section>
      </main>

      {/* ── The agents it works with ── */}
      <section aria-label="Works with" className="relative z-10 mt-4 flex h-14 shrink-0 items-center gap-6 px-5 sm:px-8">
        <p className="micro shrink-0 text-fg/55">
          Works with the agents
          <br />
          you already use
        </p>
        <div className="relative min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]">
          <ul className="marquee flex w-max items-center gap-10 pr-10">
            {[...AGENTS, ...AGENTS].map((agent, i) => (
              <li key={`${agent.name}-${i}`} aria-hidden={i >= AGENTS.length} className="flex shrink-0 items-center gap-2.5">
                <span className="flex size-9 items-center justify-center overflow-hidden rounded-[11px] bg-[#0c0d10] shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]">
                  <Image src={agent.src} alt="" width={36} height={36} unoptimized className={agent.full ? "size-9" : "size-[18px] object-contain"} />
                </span>
                <span className="cond text-[22px] text-fg/85">{agent.name}</span>
              </li>
            ))}
          </ul>
        </div>
        <Crosshair className="hidden shrink-0 text-fg/40 sm:block" />
      </section>

      {/* ── The wordmark, bleeding off the bottom edge ── */}
      <footer className="relative z-0 flex shrink-0 items-end justify-between gap-6 overflow-hidden px-5 sm:px-8">
        <div aria-hidden className="fade-blue -mb-[0.17em] select-none text-[min(17vw,26vh)] font-bold leading-[0.82] tracking-[-0.08em]">
          Tessera.
        </div>
        <div className="micro hidden shrink-0 pb-6 text-right text-fg/55 lg:block">
          <a href="https://www.null-ptr.team" target="_blank" rel="noopener noreferrer" className="group block transition-colors hover:text-fg">
            <span className="block">Created by Vance Poitier,</span>
            <span className="block">
              Captain of <span className="text-accent underline decoration-accent/40 underline-offset-[3px] group-hover:decoration-accent">NULL* Team</span>
              <span aria-hidden className="ml-1 inline-block transition-transform group-hover:-translate-y-px group-hover:translate-x-px">↗</span>
            </span>
          </a>
          <p className="mt-3">{rail === "offline" ? "Simulated Airwallex" : "Airwallex sandbox"} · no real money</p>
          <Barcode text="TESSERA-2026" className="mt-3 ml-auto h-6 w-36 text-fg/60" />
        </div>
      </footer>
    </div>
  );
}
