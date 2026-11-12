"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IncidentListSchema, type Health, type IncidentSummary } from "../../src/server/wire";
import { api } from "@/lib/client-api";
import { needsYou } from "@/lib/tour-steps";
import { agentName, useAgentRun } from "./agent/agent-run";
import { MetalCircle } from "./kit/metal";
import { ThemeProvider, useTheme, type Theme } from "./kit/theme";
import { Chip, Toggle } from "./kit/widgets";
import { Icon } from "./landing/icons";
import { Logo } from "./logo";

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

/** The search well. Slash focuses it from anywhere; Enter away from a list takes the query to the board. */
function SearchField() {
  const { query, setQuery } = useShell();
  const pathname = usePathname();
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        ref.current?.focus();
      }
      if (event.key === "Escape" && document.activeElement === ref.current) ref.current?.blur();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <form
      role="search"
      className="relative w-full"
      onSubmit={(event) => {
        event.preventDefault();
        if (pathname !== "/dashboard" && pathname !== "/queue") router.push("/dashboard");
      }}
    >
      <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-fg/45" />
      <input
        ref={ref}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Find an invoice, a status, a rail"
        aria-label="Search incidents"
        className="well h-11 w-full rounded-full! pl-11 pr-11 text-[13px] text-fg outline-none placeholder:text-fg/40 focus:ring-2 focus:ring-accent/40 [&::-webkit-search-cancel-button]:hidden"
      />
      {query === "" ? (
        <kbd className="readout pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 rounded-md border border-fg/15 px-1.5 text-[10.5px] text-fg/45">/</kbd>
      ) : (
        <button type="button" onClick={() => setQuery("")} aria-label="Clear the search" className="absolute right-3.5 top-1/2 -translate-y-1/2 cursor-pointer text-fg/50 hover:text-fg">
          <Icon name="close" className="size-4" />
        </button>
      )}
    </form>
  );
}

/** Where you are, as a segmented track of links: the room, the queue, and the incident when you are in one. */
function Nav({ waiting }: { waiting: number }) {
  const pathname = usePathname();
  const items: { href: string; label: string; icon: Parameters<typeof Icon>[0]["name"]; on: boolean; count?: number }[] = [
    { href: "/dashboard", label: "Control room", icon: "dashboard", on: pathname === "/dashboard" },
    { href: "/queue", label: "Queue", icon: "inbox", on: pathname === "/queue", count: waiting },
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

function initials(who: string): string {
  const local = who.split("@")[0] ?? who;
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function Menubar({ health }: { health: Health | null }) {
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

        <Nav waiting={waiting.length} />

        <div className="hidden min-w-0 max-w-[380px] flex-1 sm:block">
          <SearchField />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          <span className="hidden 2xl:inline-flex" title={health?.offline ? "Airwallex simulated in-process: no network, no money" : "The Airwallex sandbox: the real API, no real money"}>
            <Chip tone="accent">{health?.offline ? "Offline rehearsal" : "Airwallex sandbox"}</Chip>
          </span>
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
          <span className="flex items-center gap-2.5">
            <span aria-hidden className="tile inverse flex size-11 items-center justify-center rounded-full! text-[12px] font-semibold text-fg">
              {initials(health?.operator ?? "operator")}
            </span>
            <span className="hidden min-w-0 leading-tight lg:block">
              <span className="block max-w-[160px] truncate text-[12.5px] font-medium">{health?.operator ?? "operator"}</span>
              <span className="block text-[11px] text-fg/50">Operator</span>
            </span>
          </span>
        </div>
      </div>
      <div className="mt-3 sm:hidden">
        <SearchField />
      </div>
    </header>
  );
}

export function AppShell({ health, theme, children }: { health: Health | null; theme: Theme; children: ReactNode }) {
  const [query, setQuery] = useState("");
  const waiting = useWaiting();
  const value = useMemo<ShellState>(() => ({ query, setQuery, waiting }), [query, waiting]);
  return (
    <ShellContext.Provider value={value}>
      <ThemeProvider initial={theme}>
        {(current) => (
          <div data-theme={current} className="desk flex min-h-dvh flex-col font-ui antialiased xl:h-dvh xl:min-h-[640px]">
            <Menubar health={health} />
            <main className="flex min-h-0 min-w-0 flex-1 flex-col xl:overflow-hidden">{children}</main>
          </div>
        )}
      </ThemeProvider>
    </ShellContext.Provider>
  );
}

/** The workspace every page fills: one screen tall from `xl`, a natural scroll below it. */
export function Workspace({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4 pt-4 sm:px-6 xl:px-7 xl:pb-5 ${className}`}>{children}</div>;
}
