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
 * The landing: one 16:9 wall, after a billboard reference (a ruled white panel beside one full-bleed monochrome
 * photograph) and a series of grainy editorial posters. The billboard says what Tessera is; the photograph shows a
 * person and an agent at one desk, in cobalt duotone, with the work playing live over it; beside it the person who
 * signs, and the proof. The agents it works with run beneath; the wordmark closes the page. Every photograph is
 * generated (scripts/gen-landing-art.ts), and nothing here is a number we cannot stand behind.
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

/** Three interlocking rings, the reference's emblem, as Tessera's three parties: agent, policy, person. */
function Rings({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 64 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="16" cy="12" r="10" />
      <circle cx="32" cy="12" r="10" />
      <circle cx="48" cy="12" r="10" />
    </svg>
  );
}

/* ── The live layer ───────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * One invoice, worked live: the same five steps Tessera's ledger records for a supplier paid by card (ACME-1048), played
 * on a loop. Who acts is named on every line: the agent, the policy, a person, the network, the ledger.
 */
const FEED: { who: string; what: string; tag: string; human?: boolean }[] = [
  { who: "Agent", what: "Read the supplier's mail", tag: "nothing arrived" },
  { who: "Policy", what: "Card allowed, no second transfer", tag: "pay_by_card" },
  { who: "Dana R.", what: "Signed the card, in writing", tag: "····4130", human: true },
  { who: "Visa TAP", what: "Checkout verified, charged once", tag: "$25.00" },
  { who: "Ledger", what: "Sealed, then proved", tag: "a41f…9c" },
];

function AgentFeed() {
  const [step, setStep] = useState(FEED.length);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setStep(0);
    const timer = setInterval(() => setStep((n) => (n + 1) % (FEED.length + 3)), 1300);
    return () => clearInterval(timer);
  }, []);
  const shown = Math.min(step, FEED.length);
  return (
    <div className="w-[min(100%,372px)] rounded-[18px] border border-white/15 bg-[rgb(3_8_28/0.62)] p-3.5 text-white shadow-[0_24px_50px_-20px_rgb(0_0_0/0.8)] backdrop-blur-xl">
      <div className="micro flex items-center justify-between text-white/60">
        <span className="flex items-center gap-2">
          <span aria-hidden className="beat size-1.5 rounded-full bg-[#7fb0ff]" />
          Live · ACME-1048
        </span>
        <span>{shown === FEED.length ? "Proved" : `Step ${String(shown + 1).padStart(2, "0")}`}</span>
      </div>
      <ol className="mt-3 space-y-1.5" aria-label="One invoice, worked by an agent and a person">
        {FEED.map((line, i) => {
          const done = i < shown;
          const now = i === shown;
          return (
            <li
              key={line.who}
              className={`grid grid-cols-[58px_1fr_auto] items-baseline gap-2 text-[11.5px] transition-opacity duration-500 ${done ? "opacity-100" : now ? "opacity-70" : "opacity-20"}`}
            >
              <span className={`micro ${line.human ? "text-[#ffd27a]" : "text-[#8fb6ff]"}`}>{line.who}</span>
              <span className="truncate text-white/90">
                {line.what}
                {now ? <span aria-hidden className="beat ml-1 inline-block h-[10px] w-[5px] translate-y-[1px] bg-white/80" /> : null}
              </span>
              <span className="micro text-white/45">{done ? line.tag : ""}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** A market line over the photograph, the billboard's chart: it draws itself, holds, and moves on. */
function MarketLine({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 400 120" preserveAspectRatio="none" className={className} fill="none">
      <g stroke="rgb(255 255 255 / 0.16)" strokeWidth="0.6">
        {[20, 50, 80, 110].map((y) => (
          <path key={y} d={`M0 ${y}H400`} vectorEffect="non-scaling-stroke" />
        ))}
        {Array.from({ length: 9 }, (_, i) => (
          <path key={i} d={`M${i * 50} 0V120`} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      <path
        className="draw-line"
        pathLength={1}
        d="M0 96 L22 90 L40 98 L62 74 L80 82 L104 60 L122 70 L146 44 L164 58 L186 40 L204 52 L228 30 L246 46 L270 22 L290 36 L312 18 L334 32 L356 12 L378 26 L400 8"
        stroke="#dce8ff"
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* ── The two photographs ───────────────────────────────────────────────────────────────────────────────────────── */

/** The billboard: a person and an agent at one desk, in cobalt duotone, with the mark laid over it and the work live on it. */
function HeroPhoto() {
  return (
    <figure className="group relative min-h-[460px] overflow-hidden rounded-[28px] bg-[#01061a] text-white shadow-[0_34px_70px_-36px_rgb(0_10_60/0.75)] xl:min-h-0">
      <Image
        src="/landing/duo-desk.webp"
        alt="A treasury lead takes a card from a robotic hand at her desk, high above a financial district"
        fill
        unoptimized
        priority
        sizes="(min-width: 1280px) 45vw, 100vw"
        className="drift-img object-cover object-[62%_50%]"
      />
      <div aria-hidden className="grain absolute inset-0 opacity-50 mix-blend-overlay" />
      <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgb(1_6_26/0.7)_0%,transparent_38%,transparent_55%,rgb(1_6_26/0.78)_100%)]" />
      {/* A scan passes over the desk, the agent at work. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[10%]">
        <div className="scan-y h-full w-full bg-[linear-gradient(180deg,transparent,rgb(143_182_255/0.16)_80%,rgb(220_232_255/0.5))]" />
      </div>
      <MarketLine className="absolute left-6 top-[25%] h-[22%] w-[44%] opacity-90 mix-blend-screen" />

      <figcaption className="relative flex h-full flex-col justify-between p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex size-12 items-center justify-center rounded-[14px] bg-white/95 shadow-[0_10px_24px_-10px_rgb(0_0_0/0.6)]">
              <Logo size={26} />
            </span>
            <span className="cond text-[clamp(34px,min(3.1vw,5.6vh),60px)] leading-none text-white">Tessera</span>
          </div>
          <p className="micro text-right text-white/70">
            Human + agent
            <br />
            one ledger
          </p>
        </div>

        <div className="flex items-end justify-between gap-4">
          <div className="micro hidden space-y-0.5 text-white/65 2xl:block">
            <p>Agents act</p>
            <p>Policy decides</p>
            <p>People sign</p>
          </div>
          <AgentFeed />
        </div>
      </figcaption>
      <Crosshair className="absolute left-[55%] top-[57%] size-7 text-white/80 transition-transform duration-700 group-hover:rotate-90" />
    </figure>
  );
}

/** The person who signs: nothing risky moves until someone does. */
function SignerPhoto() {
  return (
    <figure className="group relative min-h-[300px] overflow-hidden rounded-[24px] bg-[#01061a] text-white xl:min-h-0">
      <Image
        src="/landing/duo-signer.webp"
        alt="A finance director signs a document with a fountain pen"
        fill
        unoptimized
        sizes="(min-width: 1280px) 18vw, 50vw"
        className="drift-img object-cover object-[40%_30%]"
      />
      <div aria-hidden className="grain absolute inset-0 opacity-50 mix-blend-overlay" />
      <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgb(1_6_26/0.55)_0%,transparent_40%,rgb(1_6_26/0.85)_100%)]" />
      <figcaption className="relative flex h-full flex-col justify-between p-5">
        <div className="flex items-start justify-between">
          <span className="cond text-[clamp(26px,min(2.1vw,4vh),40px)] leading-[0.9]">
            You
            <br />
            sign.
          </span>
          <Rings className="h-5 text-white/75" />
        </div>
        <p className="micro text-white/75">
          In writing.
          <br />
          By name. Every time.
        </p>
      </figcaption>
    </figure>
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

      {/* ── The wall: a billboard, the photograph, the person who signs and the proof ── */}
      <main className="relative z-10 grid min-h-0 flex-1 gap-4 px-5 sm:px-8 xl:grid-cols-[minmax(0,0.98fr)_minmax(0,1.3fr)_minmax(0,0.5fr)]">
        {/* The billboard: the claim, set like a poster, with the rules showing. */}
        <section className="tile relative flex min-h-0 flex-col overflow-hidden rounded-[28px]! p-6 xl:p-8">
          <div aria-hidden className="pointer-events-none absolute inset-0 [clip-path:inset(0_round_28px)]">
            <div className="grain absolute inset-0 opacity-25 mix-blend-multiply [[data-theme=dark]_&]:mix-blend-screen" />
          </div>

          <div className="micro relative flex items-start justify-between text-fg/60">
            <p>
              Tessera
              <br />
              Treasury operations
              <br />
              Built on Airwallex
            </p>
            <p className="text-right">
              N°01
              <br />
              2026
            </p>
          </div>
          <div aria-hidden className="relative mt-4 h-px bg-fg/15" />

          <h1 className="cond relative mt-auto whitespace-nowrap pt-6 text-[clamp(44px,min(5.1vw,9vh),116px)] text-fg">
            <span className="cond-in block" style={{ animationDelay: "0ms" }}>
              The agentic
            </span>
            <span className="cond-in block text-accent" style={{ animationDelay: "100ms" }}>
              Treasury ops
            </span>
            <span className="cond-in flex items-end gap-4" style={{ animationDelay: "200ms" }}>
              Platform.
              <Crosshair className="mb-[0.3em] hidden size-6 text-fg/40 sm:block" />
            </span>
          </h1>

          {/* The bottom of the billboard: three ruled cells, the way a poster carries its small print. */}
          <div className="relative mt-[clamp(14px,3.4vh,40px)] grid grid-cols-[1.6fr_1fr] border-t border-fg/15 shorter:grid-cols-1 2xl:grid-cols-[1.4fr_1fr_0.75fr]">
            <p className="py-4 pr-5 shorter:hidden text-[clamp(13px,min(0.95vw,1.65vh),15.5px)] leading-relaxed text-fg/70">
              Agents work the exceptions. Your policy decides. People sign. Every payment is sealed before it moves, and proved after it lands.
            </p>
            <div className="flex flex-col justify-center gap-2.5 border-l border-fg/15 py-4 pl-5 shorter:flex-row shorter:border-l-0 shorter:pb-0 shorter:pl-0">
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
            <div className="hidden flex-col justify-between border-l border-fg/15 py-4 pl-5 2xl:flex">
              <p className="micro text-fg/55">
                57 / 57
                <br />
                attacks held
              </p>
              <Barcode text="TESSERA-TREASURY-OPS" className="h-8 w-full text-fg/70" />
            </div>
          </div>
          <dl className="micro relative grid grid-cols-3 border-t border-fg/15 pt-3 text-fg/55 short:hidden">
            {[
              ["Airwallex", "payouts · FX · Visa"],
              ["Any model", "over MCP"],
              ["1 payment", "per invoice, max"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-fg/80">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <HeroPhoto />

        <section aria-label="People sign, the ledger proves" className="grid min-h-0 grid-cols-2 gap-4 xl:grid-cols-1 xl:grid-rows-[1.15fr_1fr]">
          <SignerPhoto />
          <article className="relative flex min-h-0 flex-col overflow-hidden rounded-[24px] bg-[#04060c] p-5 text-white">
            <div aria-hidden className="grain absolute inset-0 opacity-40 mix-blend-overlay" />
            <div aria-hidden className="absolute -right-10 -top-10 size-40 rounded-full bg-[#2b74ff] opacity-40 blur-3xl" />
            <div className="relative flex items-start justify-between">
              <span className="cond text-[clamp(22px,min(1.8vw,3.4vh),34px)] leading-[0.9]">
                Sealed,
                <br />
                then proved.
              </span>
              <span className="micro text-white/55">sha-256</span>
            </div>
            <div className="relative mt-auto">
              <Chain />
              <Barcode text="TESSERA-PROOF-0001" className="h-6 w-full text-white/75" />
            </div>
          </article>
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
      <footer className="relative z-0 flex shrink-0 items-end justify-between gap-6 overflow-hidden px-5 pb-[clamp(10px,2.2vh,24px)] sm:px-8">
        <div aria-hidden className="fade-blue select-none pb-[0.04em] text-[min(15vw,22vh)] font-bold leading-[0.86] tracking-[-0.08em]">
          Tessera.
        </div>
        <div className="micro hidden shrink-0 pb-1 text-right text-fg/55 lg:block">
          <a href="https://www.null-ptr.team" target="_blank" rel="noopener noreferrer" className="group block transition-colors hover:text-fg">
            <span className="block">Created by Vance Poitier,</span>
            <span className="block">
              Captain of <span className="text-accent underline decoration-accent/40 underline-offset-[3px] group-hover:decoration-accent">NULL* Team</span>
              <span aria-hidden className="ml-1 inline-block transition-transform group-hover:-translate-y-px group-hover:translate-x-px">↗</span>
            </span>
          </a>
          <p className="mt-3 flex justify-end gap-3">
            <Link href="/terms" className="hover:text-fg">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-fg">
              Privacy
            </Link>
          </p>
          <p className="mt-2">{rail === "offline" ? "Simulated Airwallex" : "Airwallex sandbox"} · no real money</p>
          <Barcode text="TESSERA-2026" className="mt-3 ml-auto h-6 w-36 text-fg/60" />
        </div>
      </footer>
    </div>
  );
}
