"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { passwordStrength } from "@/lib/password-strength";
import { safeNext } from "@/lib/safe-next";
import { initialsOf } from "@/lib/initials";
import { useSignedIn, type SignedIn } from "@/lib/use-account";
import { storeFaceChoice } from "../kit/agent-mark";
import { Btn, LinkBtn } from "../kit/metal";
import { useTheme } from "../kit/theme";
import { Capsule, Toggle, type ChipTone } from "../kit/widgets";
import { Icon } from "../landing/icons";
import { Logo } from "../logo";

/** Sign in, sign up, or (one operator, no accounts) the door to that operator's control room. */
export type AuthMode = "sign-in" | "sign-up" | "operator";
type Mode = AuthMode;


/** What Better Auth says, in words a person can act on. */
function sentence(error: { code?: string; message?: string; status?: number } | null | undefined): string {
  if (!error) return "Something went wrong. Try again.";
  if (error.status === 429) return "Too many attempts from here. Wait a minute, then try again.";
  switch (error.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return "That email and password do not match an account.";
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "There is already an account with this email. Sign in instead.";
    case "PASSWORD_TOO_SHORT":
      return "Use at least 10 characters.";
    case "INVALID_EMAIL":
      return "That does not look like an email address.";
    default:
      return error.message ?? "Something went wrong. Try again.";
  }
}

/* ── Agents: any of them can hold the card ──────────────────────────────────────────────────────────────────────── */

/**
 * Each agent's card has its own plate: artwork generated with fal.ai and upscaled (scripts/gen-card-art.ts), after
 * two references, a set of dark art cards and a series of grainy editorial posters. `scrim` is how much the plate
 * needs darkening on the left for the writing to read; `mirror` flips a plate whose calm side is on the right.
 */
const AGENTS = [
  { id: "hermes", name: "Hermes", src: "/agents/hermes-agent-on-dark.svg", full: true, plate: "Liquid chrome", scrim: 0.6, mirror: true },
  { id: "claude", name: "Claude", src: "/agents/claude.svg", plate: "Lava field", scrim: 0.55 },
  { id: "openai", name: "OpenAI", src: "/agents/openai-on-dark.svg", plate: "Lunar", scrim: 0.45 },
  { id: "gemini", name: "Gemini", src: "/agents/gemini.svg", plate: "Spectrum", scrim: 0.4 },
  { id: "cursor", name: "Cursor", src: "/agents/cursor-on-dark.svg", plate: "Radiograph", scrim: 0.3 },
  { id: "copilot", name: "Copilot", src: "/agents/githubcopilot-on-dark.svg", plate: "Ember", scrim: 0.45 },
] as const;
type Agent = (typeof AGENTS)[number];

function AgentGlyph({ agent, size }: { agent: Agent; size: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- fixed local SVGs
    <img
      src={agent.src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={"full" in agent ? "rounded-[28%]" : "object-contain"}
    />
  );
}

/* ── The card: an art plate per agent ─────────────────────────────────────────────────────────────────────────── */

const CARD_RADIUS = 26;

/** The plate's image: the 1000 px file for phones and 1x screens, the 2000 px one for retina at full size. */
function plateProps(agent: Agent) {
  return {
    src: `/cards/${agent.id}-1000.webp`,
    srcSet: `/cards/${agent.id}-1000.webp 1000w, /cards/${agent.id}.webp 2000w`,
    sizes: "(min-width: 640px) 500px, 86vw",
  };
}

/**
 * The art plate under a face, in layers: the picture (drifting against the tilt, so it sits behind the glass), a scrim
 * on the left where the writing goes, film grain, and a holographic sheen that follows the pointer. Every agent's
 * plate is stacked and only the chosen one shows, so switching agents crossfades instead of popping.
 */
function Plate({ agent, seen, tilt, back = false, children }: { agent: Agent; seen: ReadonlySet<string>; tilt: Tilt; back?: boolean; children: ReactNode }) {
  const drift = (a: Agent) =>
    `translate3d(${(-tilt.y * 0.55).toFixed(2)}px, ${(tilt.x * 0.55).toFixed(2)}px, 0) scale(${back ? 1.18 : 1.07})${"mirror" in a ? " scaleX(-1)" : ""}`;
  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0b0c10]" style={{ borderRadius: CARD_RADIUS }}>
      {AGENTS.filter((a) => seen.has(a.id)).map((a) => (
        // eslint-disable-next-line @next/next/no-img-element -- pre-sized local WebP plates with their own srcset
        <img
          key={a.id}
          {...plateProps(a)}
          alt=""
          aria-hidden
          draggable={false}
          decoding="async"
          fetchPriority={a.id === agent.id ? "high" : "low"}
          className="absolute inset-0 h-full w-full select-none object-cover"
          style={{ opacity: a.id === agent.id ? 1 : 0, transform: drift(a), transition: "opacity 700ms ease-out, transform 250ms ease-out", filter: back ? "blur(16px) brightness(0.42) saturate(1.15)" : undefined }}
        />
      ))}
      {back ? null : (
        <div
          aria-hidden
          className="absolute inset-0 transition-opacity duration-700"
          style={{
            background: `linear-gradient(90deg, rgb(3 4 7 / ${agent.scrim}) 0%, rgb(3 4 7 / ${agent.scrim * 0.45}) 50%, transparent 78%), linear-gradient(0deg, rgb(3 4 7 / 0.55) 0%, transparent 42%), linear-gradient(180deg, rgb(3 4 7 / 0.35) 0%, transparent 28%)`,
          }}
        />
      )}
      <div aria-hidden className="film-grain absolute inset-0" />
      <div
        aria-hidden
        className="holo-sheen absolute inset-0 transition-opacity duration-500"
        // While the pointer is on the card the sheen follows it; the idle drift (an animation) would override it.
        style={{ opacity: tilt.on ? 0.55 : 0.22, ...(tilt.on ? { animation: "none", backgroundPosition: `${tilt.gx}% ${tilt.gy}%` } : {}) }}
      />
      {children}
    </div>
  );
}

/** A thin registration cross, after the posters. */
function Crosshair({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className={`size-4 text-white/55 ${className}`} fill="none" stroke="currentColor" strokeWidth="1">
      <path d="M10 0v20M0 10h20" />
      <circle cx="10" cy="10" r="4" />
    </svg>
  );
}

/** The EMV chip, after the reference cards: a hairline outline, no fill. */
function Chip() {
  return (
    <svg aria-hidden viewBox="0 0 44 34" className="h-[30px] w-[40px] text-white/70" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="1" y="1" width="42" height="32" rx="7" />
      <path d="M1 12h12v10H1M43 12H31v10h12M13 1v11M31 1v11M13 22v11M31 22v11M13 17h18" />
    </svg>
  );
}

/**
 * One face of the card, shown only while it faces the viewer; the swap lands as the card turns edge-on. Safari does not
 * always honour backface-visibility on a face with filtered layers, so the hidden face is also made transparent.
 */
const face = (showing: boolean) => ({ opacity: showing ? 1 : 0, transition: "opacity 0s linear 90ms" });

/** Four digits that belong to this email, so the card looks like theirs as they type. */
function digitsFor(text: string): string {
  let hash = 7;
  for (const char of text.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) % 10_000;
  return String(hash).padStart(4, "0");
}

type Tilt = { x: number; y: number; gx: number; gy: number; on: boolean };

function Card({
  mode,
  name,
  email,
  password,
  flipped,
  agent,
  swiping,
  account,
}: {
  mode: Mode;
  name: string;
  email: string;
  password: string;
  flipped: boolean;
  agent: Agent;
  swiping: boolean;
  /** Already signed in: the card is theirs, by name. */
  account: SignedIn | null;
}) {
  const [tilt, setTilt] = useState<Tilt>({ x: 0, y: 0, gx: 50, gy: 30, on: false });
  // Plates load as agents are picked (the first at once), and the rest quietly once the page is idle.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set([agent.id]));
  useEffect(() => setSeen((s) => (s.has(agent.id) ? s : new Set([...s, agent.id]))), [agent.id]);
  useEffect(() => {
    const warm = () => setSeen(new Set(AGENTS.map((a) => a.id)));
    const idle = window.requestIdleCallback?.(warm, { timeout: 2500 });
    const timer = idle === undefined ? window.setTimeout(warm, 1500) : undefined;
    return () => (idle === undefined ? window.clearTimeout(timer) : window.cancelIdleCallback(idle));
  }, []);
  const plateNo = String(AGENTS.findIndex((a) => a.id === agent.id) + 1).padStart(2, "0");
  const strength = passwordStrength(password);
  const signingUp = mode === "sign-up" && !account;
  const holder = account ? account.name || account.email : mode === "operator" ? "Operator" : signingUp ? name.trim() || "Your name" : email.trim() || "you@company.com";
  const since = new Date().toLocaleDateString("en-GB", { month: "2-digit", year: "2-digit" });

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - box.left) / box.width;
    const py = (event.clientY - box.top) / box.height;
    setTilt({ x: (0.5 - py) * 14, y: (px - 0.5) * 18, gx: px * 100, gy: py * 100, on: true });
  };

  return (
    <div className="[perspective:1600px]">
      <div
        onPointerMove={move}
        onPointerLeave={() => setTilt({ x: 0, y: 0, gx: 50, gy: 30, on: false })}
        className={`relative aspect-[1.586] w-[min(500px,86vw)] [transform-style:preserve-3d] ${swiping ? "transition-transform duration-500 ease-in" : "transition-transform duration-200 ease-out"}`}
        style={{ transform: swiping ? "translateY(-40px) rotateX(18deg) scale(0.94)" : `rotateX(${tilt.x}deg) rotateY(${tilt.y + (flipped ? 180 : 0)}deg)` }}
      >
        {/* Front. Each face is also hidden outright while it faces away: Safari ignores backface-visibility on a face
            that holds a WebGL canvas (the metal), and showed the back, mirrored, in place of the front. */}
        <div className="chroma-edge absolute inset-0 p-[1.5px] [backface-visibility:hidden]" style={{ ...face(!flipped), borderRadius: CARD_RADIUS + 1.5, boxShadow: "0 40px 70px -35px rgb(0 0 0 / 0.75), 0 8px 18px -8px rgb(0 0 0 / 0.35)" }}>
          <div className="relative h-full w-full">
          <Plate agent={agent} seen={seen} tilt={tilt}>
            <div className="relative flex h-full flex-col justify-between p-7 text-white">
              <div className="flex items-start justify-between">
                <div className="flex flex-col gap-2">
                  <span className="flex items-center gap-2.5">
                    <Logo size={26} />
                    <span className="cond text-[22px] leading-none tracking-[0.02em]">Tessera</span>
                  </span>
                  <span className="readout text-[9.5px] uppercase tracking-[0.18em] text-white/60 [text-shadow:0_1px_8px_rgb(0_0_0/0.6)]">
                    Plate {plateNo} / {agent.plate}
                  </span>
                </div>
                <span className="flex items-center gap-2 rounded-full bg-black/35 py-1 pl-1 pr-3 ring-1 ring-white/15 backdrop-blur-md" title={`Issued for ${agent.name}`}>
                  <span className="flex size-7 items-center justify-center overflow-hidden rounded-full bg-black/60">
                    <AgentGlyph agent={agent} size={"full" in agent ? 28 : 16} />
                  </span>
                  <span className="text-[12px] font-medium">{agent.name}</span>
                </span>
              </div>

              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <span className="readout text-[10px] uppercase tracking-[0.2em] text-white/55">{signingUp ? "New workspace" : "Control room"}</span>
                  <p className="mt-1 truncate text-[30px] font-semibold leading-none tracking-[-0.035em] [text-shadow:0_1px_18px_rgb(0_0_0/0.45)]">
                    {signingUp ? (name.trim() ? `${name.trim().split(" ")[0]}’s workspace` : "Your workspace") : "Welcome back"}
                  </p>
                </div>
                <Crosshair className="mb-1 shrink-0" />
              </div>

              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <p className="tnum whitespace-nowrap text-[min(21px,4.6vw)] font-medium tracking-[0.06em] text-white [text-shadow:0_1px_14px_rgb(0_0_0/0.5)]">
                    1X00 ···· ···· {digitsFor(account ? account.email : mode === "operator" ? "operator" : email)}
                  </p>
                  <p className="mt-1.5 flex items-baseline gap-3 text-[12.5px]">
                    <span className="max-w-[260px] truncate text-white/90">{holder}</span>
                    <span className="readout text-white/50">{since}</span>
                  </p>
                </div>
                <Chip />
              </div>
            </div>
          </Plate>
          {/* Glare that follows the pointer, so the plate reads as glass over a picture. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 transition-opacity duration-300"
            style={{ borderRadius: CARD_RADIUS, opacity: tilt.on ? 1 : 0.35, background: `radial-gradient(60% 50% at ${tilt.gx}% ${tilt.gy}%, rgb(255 255 255 / 0.18), transparent 60%)` }}
          />
          </div>
        </div>

        {/* Back: what happens to what you type */}
        <div className="chroma-edge absolute inset-0 p-[1.5px] [backface-visibility:hidden] [transform:rotateY(180deg)]" style={{ ...face(flipped), borderRadius: CARD_RADIUS + 1.5, boxShadow: "0 40px 70px -35px rgb(0 0 0 / 0.75)" }}>
          <div className="relative h-full w-full">
          <Plate agent={agent} seen={seen} tilt={tilt} back>
            <div className="relative flex h-full flex-col text-white">
              <div aria-hidden className="mt-7 h-12 w-full bg-black/85" />
              <div className="flex flex-1 flex-col justify-between p-7 pt-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 flex-1 items-center rounded-[8px] bg-white/85 px-3">
                    <span className="readout truncate text-[16px] tracking-[0.25em] text-black/80">{password ? "•".repeat(Math.min(password.length, 22)) : "your password"}</span>
                  </div>
                  <span className="readout rounded-[8px] bg-white/10 px-3 py-2.5 text-[12px]">{mode === "sign-up" ? strength.label : "sealed"}</span>
                </div>
                <div className="flex items-end justify-between gap-4">
                  <div className="space-y-1 text-[11.5px] leading-snug text-white/60">
                    <p className="flex items-center gap-2 text-white/85">
                      <Icon name="lock" className="size-3.5" /> Hashed, never stored as typed.
                    </p>
                    <p>Keys you add later: sealed with AES-256-GCM, a key per workspace.</p>
                    <p>Sandbox only. Real money cannot move here.</p>
                  </div>
                  <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-[14px] bg-black/60">
                    <AgentGlyph agent={agent} size={"full" in agent ? 48 : 24} />
                  </span>
                </div>
              </div>
            </div>
          </Plate>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── The form ───────────────────────────────────────────────────────────────────────────────────────────────────── */

const FIELD = "well h-11 w-full rounded-[14px]! px-3.5 text-[14px] text-fg outline-none placeholder:text-fg/35 transition-shadow focus-visible:ring-2 focus-visible:ring-accent/45";
const STRENGTH_TONE: Record<number, ChipTone> = { 0: "neutral", 1: "bad", 2: "warn", 3: "accent", 4: "accent" };

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[12px] font-medium text-fg/70">
          {label}
        </label>
        {hint}
      </div>
      {children}
    </div>
  );
}

/** A link click handled in place (left button, no modifier keys), or left to navigate when there is no handler. */
function inPlace(handler: (() => void) | undefined) {
  if (!handler) return undefined;
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    handler();
  };
}

/** Already signed in on this browser: no form to fill in again, just the way back in (or out). */
function SessionDoor({ account, next }: { account: SignedIn; next: string | null }) {
  const [leaving, setLeaving] = useState(false);
  const first = account.name.trim().split(/\s+/)[0] || account.email;
  async function signOut() {
    setLeaving(true);
    // The session store hears it at once and everything that shows who is signed in follows (this screen turns back
    // into the sign-in form, the landing above it into "Sign in"). No server refresh: under the peeled landing the
    // address is the landing's own, and refreshing it would swap the page out from under the sheet.
    await authClient.signOut().catch(() => undefined);
    setLeaving(false);
  }
  return (
    <div className="relative">
      <div className="tile relative rounded-[28px]! p-2">
        <p className="well flex h-11 items-center justify-center gap-2 rounded-full! text-[13px] font-medium text-fg/60">
          <span aria-hidden className="beat size-1.5 rounded-full bg-accent" />
          Signed in on this browser
        </p>
        <div className="flex items-center gap-3.5 px-4 pt-5">
          <span aria-hidden className="tile inverse flex size-12 shrink-0 items-center justify-center rounded-full! text-[14px] font-semibold text-fg">
            {initialsOf(account.name || account.email)}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[23px] font-semibold leading-tight tracking-[-0.04em]">Welcome back, {first}.</h1>
            <p className="readout truncate text-[12px] text-fg/55">{account.email}</p>
          </div>
        </div>
        <p className="px-4 pt-3 text-[13px] leading-relaxed text-fg/55">Your control room is as you left it. No password needed until you sign out.</p>
        <div className="space-y-2.5 px-2 pb-2 pt-5">
          <LinkBtn size="md" block href={safeNext(next, "/dashboard")} icon={<Icon name="dashboard" className="size-4" />}>
            Enter the control room
          </LinkBtn>
          <LinkBtn size="md" block tone="secondary" href="/workspace">
            Workspace and keys
          </LinkBtn>
        </div>
      </div>
      <p className="mt-3 px-4 text-center text-[11px] leading-relaxed text-fg/45">
        Not {first}?{" "}
        <button type="button" onClick={signOut} disabled={leaving} className="cursor-pointer text-fg/70 underline underline-offset-2 hover:text-fg disabled:opacity-50">
          {leaving ? "Signing out…" : "Sign out"}
        </button>
      </p>
    </div>
  );
}

/** One operator, no accounts: nothing to type. The card is theirs already; this is the way in. */
function OperatorDoor() {
  return (
    <div className="relative">
      <div className="tile relative rounded-[28px]! p-2">
        <p className="well flex h-11 items-center justify-center gap-2 rounded-full! text-[13px] font-medium text-fg/60">
          <span aria-hidden className="beat size-1.5 rounded-full bg-accent" />
          One operator · no accounts
        </p>
        <div className="px-4 pb-1 pt-5">
          <h1 className="text-[23px] font-semibold leading-tight tracking-[-0.04em]">Welcome back.</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-fg/55">
            This control room belongs to one operator, so there is no password to type. The agent has the legwork; the signatures are yours.
          </p>
        </div>
        <div className="space-y-2.5 px-2 pb-2 pt-5">
          <LinkBtn size="md" block href="/dashboard" icon={<Icon name="dashboard" className="size-4" />}>
            Enter the control room
          </LinkBtn>
          <LinkBtn size="md" block tone="secondary" href="/dashboard?compose=1">
            Send a payout
          </LinkBtn>
        </div>
      </div>
      <p className="mt-3 px-4 text-center text-[11px] leading-relaxed text-fg/45">Accounts, each with its own keys, come with the multi-tenant host.</p>
    </div>
  );
}

export interface AuthScreenProps {
  mode: Mode;
  next: string | null;
  /** Who is already signed in on this browser, if anyone: they get the way back in, not the form. */
  account?: SignedIn | null;
  /** Switch between signing in and creating an account in place (under the peeled landing) instead of navigating. */
  onSwitch?: (mode: "sign-in" | "sign-up") => void;
  /** Go back to the landing in place: put the peeled sheet back down. */
  onHome?: () => void;
}

/** The sign-in screen on the multi-tenant host, knowing who is signed in and keeping up as that changes. */
export function AccountAuthScreen({ initial, ...props }: Omit<AuthScreenProps, "account"> & { initial: SignedIn | null }) {
  const account = useSignedIn(initial);
  return <AuthScreen {...props} account={account} />;
}

export function AuthScreen({ mode, next, account = null, onSwitch, onHome }: AuthScreenProps) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [agent, setAgent] = useState<Agent>(AGENTS[0]);
  const [busy, setBusy] = useState(false);
  const [swiping, setSwiping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signUp = mode === "sign-up";
  // Signed in already, and not in the middle of signing in (the store learns of a new session before the card swipes).
  const known = account && !busy ? account : null;
  const strength = passwordStrength(password);
  const matches = confirm.length > 0 && confirm === password;
  const mismatch = confirm.length > 0 && !password.startsWith(confirm) && confirm !== password;
  const ready = email.includes("@") && password.length >= (signUp ? 10 : 1) && (!signUp || (name.trim().length > 0 && matches));
  // A new account always meets its workspace first (rehearsal, keys); a returning one goes where it was headed.
  const destination = signUp ? "/workspace?welcome=1" : safeNext(next, "/dashboard");
  const otherHref = `${signUp ? "/sign-in" : "/sign-up"}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setError(null);
    setConfirm("");
  }, [mode]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setFlipped(false);
    const result = signUp
      ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
      : await authClient.signIn.email({ email: email.trim(), password });
    if (result.error) {
      setError(sentence(result.error));
      setBusy(false);
      return;
    }
    // The card is "swiped": a beat of motion, then the control room. Replace, not push: Back from the control room
    // must not land on a sign-in form for someone who is signed in.
    setSwiping(true);
    setTimeout(() => {
      router.replace(destination);
      router.refresh();
    }, 420);
  }

  return (
    <main className="flex min-h-dvh flex-col xl:h-full xl:min-h-0">
      <header className="flex shrink-0 items-center justify-between px-6 pt-5">
        <Link href="/" onClick={inPlace(onHome)} className="flex items-center gap-2.5 text-[13px] text-fg/60 hover:text-fg">
          <span className="tile flex size-9 items-center justify-center rounded-[11px]!">
            <Logo size={20} />
          </span>
          Tessera
        </Link>
        <Toggle
          label="Appearance"
          value={theme}
          onChange={setTheme}
          options={[
            { id: "light", label: <Icon name="sun" className="size-4" />, title: "Light" },
            { id: "dark", label: <Icon name="moon" className="size-4" />, title: "Dark" },
          ]}
        />
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-6">
        <div className="grid items-center gap-12 lg:grid-cols-[auto_400px]">
          {/* The card and the agents that can hold it */}
          <div className="flex flex-col items-center gap-7">
            <Card mode={mode} name={name} email={email} password={password} flipped={flipped} agent={agent} swiping={swiping} account={known} />
            <div className="flex flex-col items-center gap-3">
              <span className="text-[12px] text-fg/50">Works with the agent you already use. Pick one.</span>
              <ul className="flex items-center gap-2.5" aria-label="Agents">
                {AGENTS.map((option) => {
                  const on = option.id === agent.id;
                  return (
                    <li key={option.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setAgent(option);
                          // The agent picked here is the face the console shows, until a model says otherwise.
                          storeFaceChoice(option.id);
                        }}
                        aria-pressed={on}
                        title={option.name}
                        className={`group relative flex size-12 cursor-pointer items-center justify-center overflow-hidden rounded-[15px] bg-[#0c0d10] shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_10px_20px_-12px_rgb(0_0_0/0.7)] transition-transform duration-200 hover:-translate-y-1 ${
                          on ? "-translate-y-1 ring-2 ring-accent ring-offset-2 ring-offset-canvas" : ""
                        }`}
                      >
                        <AgentGlyph agent={option} size={"full" in option ? 48 : 22} />
                        <span className="sr-only">{option.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          {/* The wallet the card came from: the form (or, with one operator and no accounts, the door) */}
          {mode === "operator" ? (
            <OperatorDoor />
          ) : known ? (
            <SessionDoor account={known} next={next} />
          ) : (
          <div className="relative">
            <div className="tile relative rounded-[28px]! p-2">
              <nav aria-label="Account" className="well grid grid-cols-2 gap-1 rounded-full! p-1">
                {(["sign-in", "sign-up"] as const).map((tab) => (
                  <Link
                    key={tab}
                    href={tab === mode ? "#" : otherHref}
                    onClick={tab === mode ? (event) => event.preventDefault() : inPlace(onSwitch && (() => onSwitch(tab)))}
                    aria-current={tab === mode ? "page" : undefined}
                    className={`flex h-9 items-center justify-center rounded-full text-[13px] font-medium transition-colors ${tab === mode ? "tile rounded-full! text-fg" : "text-fg/50 hover:text-fg/80"}`}
                  >
                    {tab === "sign-in" ? "Sign in" : "Create account"}
                  </Link>
                ))}
              </nav>

              <div className="px-4 pb-1 pt-5">
                <h1 className="text-[23px] font-semibold leading-tight tracking-[-0.04em]">{signUp ? "Get your card." : "Welcome back."}</h1>
                <p className="mt-1 text-[13px] leading-relaxed text-fg/55">
                  {signUp ? "A private workspace in seconds, in offline rehearsal until you bring keys." : "Sign in to your control room."}
                </p>
              </div>


              <form onSubmit={submit} className="space-y-3 px-2 pb-2 pt-4" noValidate>
                {signUp ? (
                  <Field id={nameId} label="Your name">
                    <input id={nameId} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Ada Lovelace" maxLength={80} className={FIELD} />
                  </Field>
                ) : null}
                <Field id={emailId} label="Work email">
                  <input id={emailId} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="ada@company.com" className={FIELD} />
                </Field>
                <Field
                  id={passwordId}
                  label="Password"
                  hint={signUp ? <span className={`text-[11.5px] ${strength.score >= 3 ? "text-accent" : strength.score === 0 ? "text-fg/45" : "text-warn"}`}>{password ? strength.label : "10 characters or more"}</span> : null}
                >
                  <div className="relative">
                    <input
                      ref={passwordRef}
                      id={passwordId}
                      type={reveal ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onFocus={() => setFlipped(true)}
                      onBlur={() => setFlipped(false)}
                      autoComplete={signUp ? "new-password" : "current-password"}
                      placeholder={signUp ? "A passphrase works best" : "Your password"}
                      maxLength={128}
                      className={`${FIELD} pr-11`}
                    />
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setReveal((was) => !was);
                        passwordRef.current?.focus();
                      }}
                      aria-label={reveal ? "Hide the password" : "Show the password"}
                      aria-pressed={reveal}
                      className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-fg/50 hover:text-fg"
                    >
                      <svg aria-hidden viewBox="0 0 24 24" className="size-[17px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
                        <circle cx="12" cy="12" r="3" />
                        {reveal ? null : <path d="m3 3 18 18" />}
                      </svg>
                    </button>
                  </div>
                  {signUp ? (
                    <div className="mt-2 flex items-center gap-3">
                      <Capsule label={`Password strength: ${strength.label}`} value={strength.score / 4} tone={STRENGTH_TONE[strength.score]} width={96} height={22} stroke={4}>
                        <span />
                      </Capsule>
                      <span className="text-[11px] leading-snug text-fg/45">{strength.score === 4 ? "As strong as it gets." : "Length beats symbols. Keep going to close the ring."}</span>
                    </div>
                  ) : null}
                </Field>
                {signUp ? (
                  <Field
                    id={confirmId}
                    label="Confirm password"
                    hint={
                      matches ? (
                        <span className="flex items-center gap-1 text-[11.5px] text-accent">
                          <Icon name="check" className="size-3.5" />
                          Matches
                        </span>
                      ) : mismatch ? (
                        <span className="text-[11.5px] text-bad">Does not match yet</span>
                      ) : null
                    }
                  >
                    <input
                      id={confirmId}
                      type={reveal ? "text" : "password"}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      onFocus={() => setFlipped(true)}
                      onBlur={() => setFlipped(false)}
                      onPaste={(e) => e.preventDefault()}
                      autoComplete="new-password"
                      placeholder="Type it once more"
                      maxLength={128}
                      aria-invalid={mismatch}
                      className={`${FIELD} ${mismatch ? "ring-2 ring-bad/40" : matches ? "ring-2 ring-accent/35" : ""}`}
                    />
                  </Field>
                ) : null}

                {error ? (
                  <p role="alert" className="well flex items-start gap-2.5 rounded-[14px]! px-3.5 py-2.5 text-[12.5px] text-bad">
                    <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-bad" />
                    {error}
                  </p>
                ) : null}

                <Btn type="submit" size="md" block disabled={!ready} busy={busy}>
                  {signUp ? "Issue my workspace" : "Sign in"}
                </Btn>
              </form>
            </div>
            <p className="mt-3 px-4 text-center text-[11px] leading-relaxed text-fg/45">
              {signUp ? "Sandbox keys only. Real money cannot move here." : "Forgot your password? Ask whoever runs this Tessera to reset it."}
            </p>
          </div>
          )}
        </div>
      </div>
    </main>
  );
}
