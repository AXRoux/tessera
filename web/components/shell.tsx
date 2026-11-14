"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import type { AgentFaceChoice } from "@/lib/agent-face";
import { initialsOf } from "@/lib/initials";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IncidentListSchema, type Health, type IncidentSummary } from "../../src/server/wire";
import { api } from "@/lib/client-api";
import { needsYou } from "@/lib/tour-steps";
import { agentName, useAgentRun } from "./agent/agent-run";
import { AgentFaceProvider } from "./kit/agent-mark";
import { MetalCircle } from "./kit/metal";
import { ThemeProvider, useTheme, type Theme } from "./kit/theme";
import { Chip, Toggle } from "./kit/widgets";
import { Icon } from "./landing/icons";
import { Logo } from "./logo";
import { CommandPalette, useShortcutLabel } from "./command-palette";

/**
 * The desk the operator works at: a menubar across the top and a workspace that fills exactly one screen.
 *
 * From `xl` (1280 wide, the smallest 16:9 laptop) every page is locked to the viewport and panels scroll inside
 * themselves; below it, the same pages fall back to a natural scrolling column. The palette is a cookie, so the first
 * paint is already light or dark.
 */

interface ShellState {
  /** What the menubar's search holds; the board and the queue filter with it. */
  query: string;
  setQuery: (query: string) => void;
  /** Everything waiting on a person, most urgent first, read on the shell's own cadence. */
  waiting: ReturnType<typeof needsYou<IncidentSummary>>;
  /** Opens the ⌘K command palette. */
  openPalette: () => void;
}

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell needs <AppShell>");
  return shell;
}

function useWaiting(): ShellState["waiting"] {
  const [items, setItems] = useState<IncidentSummary[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api("obligations", IncidentListSchema)
        .then((list) => alive && setItems(list.items))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => !document.hidden && void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return useMemo(() => needsYou(items), [items]);
}

/**
 * The search well: the way into the ⌘K command palette (⌘K, Ctrl K or / from anywhere, or a click). It shows the board's
 * current filter, if any, with a way to clear it.
 */
function SearchField() {
  const { query, setQuery, openPalette } = useShell();
  const shortcut = useShortcutLabel();
  return (
    <div role="search" className="relative w-full">
      <button
        type="button"
        onClick={openPalette}
        aria-label={`Search and commands (${shortcut})`}
        className="well flex h-11 w-full cursor-pointer items-center rounded-full! pl-11 pr-14 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span className={`truncate ${query ? "text-fg" : "text-fg/40"}`}>{query ? `Filtering for “${query}”` : "Search or jump to…"}</span>
      </button>
      <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-fg/45" />
      {query === "" ? (
        <kbd className="readout pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 rounded-md border border-fg/15 px-1.5 text-[10.5px] text-fg/45">{shortcut}</kbd>
      ) : (
        <button type="button" onClick={() => setQuery("")} aria-label="Clear the filter" className="absolute right-3.5 top-1/2 -translate-y-1/2 cursor-pointer text-fg/50 hover:text-fg">
          <Icon name="close" className="size-4" />
        </button>
      )}
    </div>
  );
}

/** Where you are, as a segmented track of links: the room, the queue, and the incident when you are in one. */
function Nav({ waiting, accounts }: { waiting: number; accounts: boolean }) {
  const pathname = usePathname();
  const items: { href: string; label: string; icon: Parameters<typeof Icon>[0]["name"]; on: boolean; count?: number }[] = [
    { href: "/dashboard", label: "Control room", icon: "dashboard", on: pathname === "/dashboard" },
    { href: "/queue", label: "Queue", icon: "inbox", on: pathname === "/queue", count: waiting },
    ...(accounts ? [{ href: "/workspace", label: "Keys", icon: "lock" as const, on: pathname === "/workspace" }] : []),
  ];
  if (pathname.startsWith("/incidents/")) items.push({ href: pathname, label: "Incident", icon: "file", on: true });
  return (
    <nav aria-label="Workspace" className="well hidden items-center gap-0.5 rounded-full p-1 md:flex">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.on ? "page" : undefined}
          className={`inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium transition-colors ${item.on ? "tile rounded-full! text-fg" : "text-fg/55 hover:text-fg"}`}
        >
          <Icon name={item.icon} className={`size-4 ${item.on ? "text-accent" : ""}`} />
          <span className="hidden lg:inline">{item.label}</span>
          {item.count ? <span className="readout rounded-full bg-warn px-1.5 text-[10.5px] font-medium text-white">{item.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <Toggle<Theme>
      label="Appearance"
      value={theme}
      onChange={setTheme}
      options={[
        { id: "light", label: <Icon name="sun" className="size-4" />, title: "Light" },
        { id: "dark", label: <Icon name="moon" className="size-4" />, title: "Dark" },
      ]}
    />
  );
}

const initials = initialsOf;

export interface Account {
  name: string;
  email: string;
  mode: "offline" | "live";
}

/**
 * The person signed in, as a raised avatar that opens their menu: who they are, which mode their workspace is in, the
 * page for their keys, and sign out. Only in multi-tenant mode; one operator has no menu to open.
 */
function AccountMenu({ account }: { account: Account }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex cursor-pointer items-center gap-2.5 rounded-full text-left"
      >
        <span aria-hidden className="tile inverse flex size-11 items-center justify-center rounded-full! text-[12px] font-semibold text-fg">
          {initials(account.name || account.email)}
        </span>
        <span className="hidden min-w-0 leading-tight lg:block">
          <span className="block max-w-[160px] truncate text-[12.5px] font-medium">{account.name || account.email}</span>
          <span className="block text-[11px] text-fg/50">{account.mode === "live" ? "Live sandbox" : "Offline rehearsal"}</span>
        </span>
      </button>
      {open ? (
        <div role="menu" className="tray absolute right-0 top-[calc(100%+10px)] z-50 w-[300px] p-2">
          <div className="tile rounded-[20px]! px-4 py-3">
            <p className="truncate text-[13.5px] font-semibold">{account.name}</p>
            <p className="readout truncate text-[11.5px] text-fg/55">{account.email}</p>
            <span className="mt-2 inline-flex">
              <Chip tone={account.mode === "live" ? "accent" : "neutral"}>{account.mode === "live" ? "Live: your Airwallex sandbox" : "Offline rehearsal"}</Chip>
            </span>
          </div>
          <Link role="menuitem" href="/workspace" onClick={() => setOpen(false)} className="mt-1 flex items-center gap-3 rounded-[16px] px-4 py-2.5 text-[13px] hover:bg-fg/[0.05]">
            <Icon name="lock" className="size-4 text-fg/60" />
            Workspace and keys
          </Link>
          <button
            role="menuitem"
            type="button"
            disabled={leaving}
            onClick={async () => {
              setLeaving(true);
              await authClient.signOut().catch(() => undefined);
              router.push("/sign-in");
              router.refresh();
            }}
            className="flex w-full cursor-pointer items-center gap-3 rounded-[16px] px-4 py-2.5 text-left text-[13px] hover:bg-fg/[0.05] disabled:opacity-50"
          >
            <Icon name="back" className="size-4 text-fg/60" />
            {leaving ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Menubar({ health, account }: { health: Health | null; account: Account | null }) {
  const agent = useAgentRun();
  const { waiting } = useShell();
  const model = health?.agent ? agentName(health.agent, true) : null;
  return (
    <header className="relative z-30 shrink-0 px-4 pt-4 sm:px-6 xl:px-7">
      <div className="flex h-14 items-center gap-3 xl:gap-4">
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Tessera home">
          <span className="tile flex size-11 items-center justify-center rounded-[14px]!">
            <Logo size={24} />
          </span>
          <span className="hidden text-[16px] font-semibold tracking-[-0.03em] 2xl:block">Tessera</span>
        </Link>

        <Nav waiting={waiting.length} accounts={account !== null} />

        <div className="hidden min-w-0 max-w-[380px] flex-1 sm:block">
          <SearchField />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          {account && health?.offline ? (
            // A workspace without keys yet: the way to make it real, rather than a label saying it is not.
            <Link href="/workspace" className="hidden 2xl:inline-flex" title="Connect your Airwallex sandbox keys to run on the real API">
              <Chip tone="warn">Connect Airwallex</Chip>
            </Link>
          ) : (
            <span className="hidden 2xl:inline-flex" title={health?.offline ? "Airwallex simulated in-process: no network, no money" : "The Airwallex sandbox: the real API, no real money"}>
              <Chip tone="accent">{health?.offline ? "Simulated Airwallex" : "Airwallex sandbox"}</Chip>
            </span>
          )}
          {health?.agent ? (
            <span className="hidden xl:inline-flex" title={model ? `Connected model: ${model}` : undefined}>
              <Chip tone={agent.running ? "accent" : "solid"} pulse={agent.running}>
                {agent.running ? "Agent working" : "Agent standing by"}
              </Chip>
            </span>
          ) : null}
          <ThemeSwitch />
          <span className="relative">
            <MetalCircle label={waiting.length > 0 ? `${waiting.length} waiting on you` : "The queue is clear"} href="/queue" tone={waiting.length > 0 ? "primary" : "secondary"}>
              <Icon name="bell" className="size-[18px]" />
            </MetalCircle>
            {waiting.length > 0 ? (
              <span className="readout pointer-events-none absolute -right-1 -top-1 z-10 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-canvas bg-warn px-1 text-[10.5px] font-semibold text-white">
                {waiting.length}
              </span>
            ) : null}
          </span>
          {account ? (
            <AccountMenu account={account} />
          ) : (
            <span className="flex items-center gap-2.5">
              <span aria-hidden className="tile inverse flex size-11 items-center justify-center rounded-full! text-[12px] font-semibold text-fg">
                {initials(health?.operator ?? "operator")}
              </span>
              <span className="hidden min-w-0 leading-tight lg:block">
                <span className="block max-w-[160px] truncate text-[12.5px] font-medium">{health?.operator ?? "operator"}</span>
                <span className="block text-[11px] text-fg/50">Operator</span>
              </span>
            </span>
          )}
        </div>
      </div>
      <div className="mt-3 sm:hidden">
        <SearchField />
      </div>
    </header>
  );
}

export function AppShell({
  health,
  theme,
  agentFace = "auto",
  account = null,
  children,
}: {
  health: Health | null;
  theme: Theme;
  /** The agent face this browser chose (cookie), or "auto" to follow the connected model. */
  agentFace?: AgentFaceChoice;
  account?: Account | null;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const waiting = useWaiting();
  const [palette, setPalette] = useState(false);
  const openPalette = useCallback(() => setPalette(true), []);
  const closePalette = useCallback(() => setPalette(false), []);
  // ⌘K on a Mac, Ctrl K elsewhere, toggles the palette from anywhere; / opens it when nothing is being typed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target as HTMLElement | null)?.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      } else if (event.key === "/" && !typing) {
        event.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const value = useMemo<ShellState>(() => ({ query, setQuery, waiting, openPalette }), [query, waiting, openPalette]);
  return (
    <ShellContext.Provider value={value}>
      <AgentFaceProvider initialChoice={agentFace} modelName={health?.agent?.kind === "model" ? health.agent.name : null}>
      <ThemeProvider initial={theme}>
        {(current) => (
          <div data-theme={current} className="desk flex min-h-dvh flex-col font-ui antialiased xl:h-dvh xl:min-h-[640px]">
            <Menubar health={health} account={account} />
            <main className="flex min-h-0 min-w-0 flex-1 flex-col xl:overflow-hidden">{children}</main>
            <CommandPalette open={palette} onClose={closePalette} query={query} setQuery={setQuery} accounts={account !== null} />
          </div>
        )}
      </ThemeProvider>
      </AgentFaceProvider>
    </ShellContext.Provider>
  );
}

/** The workspace every page fills: one screen tall from `xl`, a natural scroll below it. */
export function Workspace({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4 pt-4 sm:px-6 xl:px-7 xl:pb-5 ${className}`}>{children}</div>;
}
