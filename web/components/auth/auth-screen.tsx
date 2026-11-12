"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { isMetalFxSupported, MetalFx, type MaskFn } from "metal-fx";
import { useEffect, useId, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { passwordStrength } from "@/lib/password-strength";
import { Btn, LinkBtn } from "../kit/metal";
import { useTheme } from "../kit/theme";
import { Capsule, Tile, Toggle, type ChipTone } from "../kit/widgets";
import { Icon } from "../landing/icons";
import { Logo } from "../logo";

type Mode = "sign-in" | "sign-up";

/** Where to go after signing in: only a path on this site, never an address someone slipped into the link. */
const safeNext = (next: string | null, fallback: string): string => (next && next.startsWith("/") && !next.startsWith("//") ? next : fallback);

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

const AGENTS = [
  { id: "hermes", name: "Hermes", src: "/agents/hermes-agent-on-dark.svg", full: true },
  { id: "claude", name: "Claude", src: "/agents/claude.svg" },
  { id: "openai", name: "OpenAI", src: "/agents/openai-on-dark.svg" },
  { id: "gemini", name: "Gemini", src: "/agents/gemini.svg" },
  { id: "cursor", name: "Cursor", src: "/agents/cursor-on-dark.svg" },
  { id: "copilot", name: "Copilot", src: "/agents/githubcopilot-on-dark.svg" },
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

/* ── The liquid-metal card ─────────────────────────────────────────────────────────────────────────────────────── */

const CARD_RADIUS = 26;
const fill =
  (radius: number): MaskFn =>
  (ctx, w, h, dpr) => {
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, radius * dpr);
    ctx.fill();
  };

/** A surface of liquid metal: the shader fills the whole card (metal-fx `mask`), darkened so writing on it reads. */
function LiquidSurface({ children, tint }: { children: ReactNode; tint: string }) {
  const [live, setLive] = useState(false);
  // After hydration, and only where WebGL2 works: elsewhere the black marble below stands in for the shader.
  useEffect(() => setLive(isMetalFxSupported()), []);
  const face = (
    <div className="relative h-full w-full overflow-hidden" style={{ borderRadius: CARD_RADIUS }}>
      {live ? null : (
        <div aria-hidden className="absolute inset-0 bg-[radial-gradient(120%_90%_at_80%_10%,#3a3d49_0%,transparent_45%),radial-gradient(90%_80%_at_10%_100%,#2b2f3b_0%,transparent_50%),linear-gradient(135deg,#0b0c10,#16171c)]" />
      )}
      <div aria-hidden className="absolute inset-0" style={{ background: tint }} />
      {children}
    </div>
  );
  if (!live) return face;
  return (
    <MetalFx
      preset="chromatic"
      theme="dark"
      mask={fill(CARD_RADIUS)}
      glowMode="ring"
      disableGlow
      strength={0.9}
      shaderScale={3.2}
      borderRadius={CARD_RADIUS}
      className="mfx-card absolute! inset-0 flex!"
    >
      {face}
    </MetalFx>
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

/** Four digits that belong to this email, so the card looks like theirs as they type. */
function digitsFor(text: string): string {
  let hash = 7;
  for (const char of text.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) % 10_000;
  return String(hash).padStart(4, "0");
}

function Card({
  mode,
  name,
  email,
  password,
  flipped,
  agent,
  swiping,
}: {
  mode: Mode;
  name: string;
  email: string;
  password: string;
  flipped: boolean;
  agent: Agent;
  swiping: boolean;
}) {
  const [tilt, setTilt] = useState({ x: 0, y: 0, gx: 50, gy: 30, on: false });
  const strength = passwordStrength(password);
  const holder = mode === "sign-up" ? name.trim() || "Your name" : email.trim() || "you@company.com";
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
        {/* Front */}
        <div className="chroma-edge absolute inset-0 p-[1.5px] [backface-visibility:hidden]" style={{ borderRadius: CARD_RADIUS + 1.5, boxShadow: "0 40px 70px -35px rgb(0 0 0 / 0.75), 0 8px 18px -8px rgb(0 0 0 / 0.35)" }}>
          <div className="relative h-full w-full">
          <LiquidSurface tint="linear-gradient(120deg, rgb(4 5 8 / 0.8) 0%, rgb(4 5 8 / 0.56) 45%, rgb(4 5 8 / 0.34) 100%)">
            <div className="relative flex h-full flex-col justify-between p-7 text-white">
              <div className="flex items-start justify-between">
                <span className="flex items-center gap-2.5">
                  <Logo size={26} />
                  <span className="text-[15px] font-bold italic tracking-[0.06em]">TESSERA</span>
                </span>
                <span className="flex items-center gap-2 rounded-full bg-white/10 py-1 pl-1 pr-3 backdrop-blur-md" title={`Issued for ${agent.name}`}>
                  <span className="flex size-7 items-center justify-center overflow-hidden rounded-full bg-black/60">
                    <AgentGlyph agent={agent} size={"full" in agent ? 28 : 16} />
                  </span>
                  <span className="text-[12px] font-medium">{agent.name}</span>
                </span>
              </div>

              <div>
                <span className="text-[12px] text-white/55">{mode === "sign-up" ? "New workspace" : "Control room"}</span>
                <p className="mt-0.5 truncate text-[30px] font-semibold leading-none tracking-[-0.03em]">
                  {mode === "sign-up" ? (name.trim() ? `${name.trim().split(" ")[0]}’s workspace` : "Your workspace") : "Welcome back"}
                </p>
              </div>

              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <p className="readout text-[19px] tracking-[0.12em] text-white/95">1X00 ···· ···· {digitsFor(email)}</p>
                  <p className="mt-1.5 flex items-baseline gap-3 text-[12.5px]">
                    <span className="max-w-[260px] truncate text-white/85">{holder}</span>
                    <span className="readout text-white/45">{since}</span>
                  </p>
                </div>
                <Chip />
              </div>
            </div>
          </LiquidSurface>
          {/* Glare that follows the pointer, so the metal reads as metal. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 transition-opacity duration-300"
            style={{ borderRadius: CARD_RADIUS, opacity: tilt.on ? 1 : 0.35, background: `radial-gradient(60% 50% at ${tilt.gx}% ${tilt.gy}%, rgb(255 255 255 / 0.18), transparent 60%)` }}
          />
          </div>
        </div>

        {/* Back: what happens to what you type */}
        <div className="chroma-edge absolute inset-0 p-[1.5px] [backface-visibility:hidden] [transform:rotateY(180deg)]" style={{ borderRadius: CARD_RADIUS + 1.5, boxShadow: "0 40px 70px -35px rgb(0 0 0 / 0.75)" }}>
          <div className="relative h-full w-full">
          <LiquidSurface tint="linear-gradient(200deg, rgb(4 5 8 / 0.8), rgb(4 5 8 / 0.6))">
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
          </LiquidSurface>
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

export function AuthScreen({ mode, next }: { mode: Mode; next: string | null }) {
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
  const session = authClient.useSession();
  const signUp = mode === "sign-up";
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
    // The card is "swiped": a beat of motion, then the control room.
    setSwiping(true);
    setTimeout(() => {
      router.push(destination);
      router.refresh();
    }, 420);
  }

  return (
    <main className="flex min-h-dvh flex-col xl:h-full xl:min-h-0">
      <header className="flex shrink-0 items-center justify-between px-6 pt-5">
        <Link href="/" className="flex items-center gap-2.5 text-[13px] text-fg/60 hover:text-fg">
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
            <Card mode={mode} name={name} email={email} password={password} flipped={flipped} agent={agent} swiping={swiping} />
            <div className="flex flex-col items-center gap-3">
              <span className="text-[12px] text-fg/50">Works with the agent you already use. Pick one.</span>
              <ul className="flex items-center gap-2.5" aria-label="Agents">
                {AGENTS.map((option) => {
                  const on = option.id === agent.id;
                  return (
                    <li key={option.id}>
                      <button
                        type="button"
                        onClick={() => setAgent(option)}
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

          {/* The wallet the card came from: the form */}
          <div className="relative">
            <div className="tile relative rounded-[28px]! p-2">
              <nav aria-label="Account" className="well grid grid-cols-2 gap-1 rounded-full! p-1">
                {(["sign-in", "sign-up"] as const).map((tab) => (
                  <Link
                    key={tab}
                    href={tab === mode ? "#" : otherHref}
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

              {session.data && !busy ? (
                <Tile className="mx-2 mt-3 flex items-center justify-between gap-3 rounded-[18px]! px-4 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-semibold">Signed in as {session.data.user.name}</span>
                    <span className="readout block truncate text-[11px] text-fg/50">{session.data.user.email}</span>
                  </span>
                  <LinkBtn href={safeNext(next, "/dashboard")}>Continue</LinkBtn>
                </Tile>
              ) : null}

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
        </div>
      </div>
    </main>
  );
}
