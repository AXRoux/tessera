"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Health } from "../../src/server/wire";
import { agentName, useAgentRun } from "./agent/agent-run";
import { Icon, type IconName } from "./landing/icons";
import { Logo } from "./logo";
import { Label } from "./ui";

/**
 * The shell the operator works inside: a rail on the left, a search field and the two live status pills on top.
 *
 * The rail is a scrollspy over the sections the page marks with `data-shell-section`, so it is right on any page under
 * it, not just the dashboard. The search field lives up here while the list it filters lives in the page, and the rail
 * badges are numbers only the page knows, so both travel through one small context.
 */

const NAV: { id: string; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "dashboard" },
  { id: "guide", label: "Getting started", icon: "check" },
  { id: "agent", label: "Agent", icon: "activity" },
  { id: "needs-you", label: "Needs you", icon: "mail" },
  { id: "incidents", label: "Incidents", icon: "file" },
  { id: "wallets", label: "Wallets", icon: "wallet" },
];

interface ShellState {
  /** What the topbar's search holds; the page filters its own lists with it. */
  query: string;
  setQuery: (query: string) => void;
  /** Reported by the page: what the rail's badges show. */
  awaiting: number;
  guide: { done: number; total: number } | null;
  report: (next: { awaiting: number; guide: { done: number; total: number } | null }) => void;
}

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell needs <ShellProvider>");
  return shell;
}

/** Publishes what only the page knows (the queue depth and guide progress) into the rail. */
export function useShellReport(next: { awaiting: number; guide: { done: number; total: number } | null }): void {
  const { report } = useShell();
  useEffect(() => report(next), [report, next.awaiting, next.guide?.done, next.guide?.total]);
}

function ShellProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [reported, setReported] = useState<{ awaiting: number; guide: { done: number; total: number } | null }>({ awaiting: 0, guide: null });
  const report = useCallback((next: { awaiting: number; guide: { done: number; total: number } | null }) => setReported(next), []);
  const value = useMemo<ShellState>(() => ({ query, setQuery, ...reported, report }), [query, reported, report]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** The one nav row: a disc-shaped icon, the label, and an optional count. Anchor scrolling, so a reload keeps its place. */
function NavRow({ item, active, badge, onNavigate }: { item: (typeof NAV)[number]; active: boolean; badge: number; onNavigate?: () => void }) {
  return (
    <a
      href={`#${item.id}`}
      onClick={onNavigate}
      aria-current={active ? "true" : undefined}
      className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] transition-colors ${
        active ? "bg-white/[0.07] text-white" : "text-muted hover:bg-white/[0.04] hover:text-soft"
      }`}
    >
      <Icon name={item.icon} className={`size-[18px] shrink-0 ${active ? "text-sky" : "text-muted group-hover:text-soft"}`} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {badge > 0 ? <span className="tnum rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white">{badge}</span> : null}
    </a>
  );
}

/** The getting-started ring: read at a glance from anywhere in the app. */
function Progress({ done, total }: { done: number; total: number }) {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const complete = done === total;
  return (
    <div className="panel p-4">
      <div className="flex items-center gap-3">
        <svg viewBox="0 0 36 36" className="size-9 shrink-0 -rotate-90" aria-hidden>
          <circle cx="18" cy="18" r={radius} fill="none" stroke="rgb(255 255 255 / 0.12)" strokeWidth="3" />
          <circle
            cx="18"
            cy="18"
            r={radius}
            fill="none"
            stroke={complete ? "#7ee0a1" : "#4f4ff1"}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${(done / total) * circumference} ${circumference}`}
          />
        </svg>
        <div className="min-w-0">
          <p className="tnum text-[13px] font-medium">
            {done}/{total} steps
          </p>
          <p className="text-[11.5px] text-muted">{complete ? "The whole loop, seen" : "Getting started"}</p>
        </div>
      </div>
      {!complete ? (
        <a href="#guide" className="mt-3 inline-flex text-[12.5px] text-sky underline decoration-white/20 underline-offset-4 hover:text-white">
          Pick up the next step
        </a>
      ) : null}
    </div>
  );
}

function Rail({ health, onNavigate }: { health: Health | null; onNavigate?: () => void }) {
  const { awaiting, guide } = useShell();
  const [active, setActive] = useState<string>("overview");

  useEffect(() => {
    const sections = [...document.querySelectorAll<HTMLElement>("[data-shell-section]")];
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const onScreen = entries.filter((e) => e.isIntersecting).map((e) => e.target.id);
        if (onScreen.length > 0) setActive(onScreen[0]!);
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 },
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex h-full flex-col gap-6 px-3 py-5">
      <Link href="/" className="flex items-center gap-3 px-3" aria-label="Tessera home">
        <Logo size={30} />
        <span className="min-w-0">
          <span className="block text-[17px] font-medium leading-none tracking-[-0.04em]">Tessera</span>
          <span className="mt-1 block text-[11.5px] text-muted">Control room</span>
        </span>
      </Link>

      <nav aria-label="Sections" className="flex flex-col gap-1">
        {NAV.map((item) => (
          <NavRow key={item.id} item={item} active={active === item.id} badge={item.id === "needs-you" ? awaiting : 0} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        {guide ? <Progress done={guide.done} total={guide.total} /> : null}
        <div className="flex items-center justify-between rounded-xl px-3 py-2 text-[12.5px] text-muted">
          <span className="flex items-center gap-2">
            <span aria-hidden className={`size-1.5 rounded-full ${health?.agent ? "bg-sky" : "bg-disabled"}`} />
            {health?.agent ? `${agentName(health.agent, true)} · ${health.agent.kind === "model" ? "model" : "script"}` : "No agent"}
          </span>
          <Link href="/" className="hover:text-white">
            The site
          </Link>
        </div>
      </div>
    </div>
  );
}

/** The topbar's search: the rail knows the sections, this knows the lists. Slash focuses it from anywhere. */
function SearchField() {
  const { query, setQuery } = useShell();
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
    <div className="relative w-full max-w-[420px]">
      <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 size-[17px] -translate-y-1/2 text-muted" />
      <input
        ref={ref}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search incidents, references, statuses"
        aria-label="Search incidents"
        className="hairline h-11 w-full rounded-full border bg-white/[0.035] pl-11 pr-12 text-[14px] text-white outline-none transition-colors placeholder:text-muted focus:border-sky/50 focus:bg-white/[0.05] [&::-webkit-search-cancel-button]:hidden"
      />
      {query === "" ? (
        <kbd className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 rounded-md border border-white/10 px-1.5 py-0.5 text-[10.5px] text-muted">
          /
        </kbd>
      ) : (
        <button
          type="button"
          onClick={() => setQuery("")}
          className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:text-white"
        >
          Clear
        </button>
      )}
    </div>
  );
}

function initials(who: string): string {
  const local = who.split("@")[0] ?? who;
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

export function AppShell({ health, children }: { health: Health | null; children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();
  const agent = useAgentRun();
  const name = agentName(health?.agent);
  const offline = health?.offline ?? false;

  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ShellProvider>
      <div className="app-canvas min-h-dvh">
        <div className="flex">
          <aside className="sticky top-0 hidden h-dvh w-[248px] shrink-0 border-r border-white/[0.06] bg-black/25 backdrop-blur-xl lg:block">
            <Rail health={health} />
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#05070f]/85 backdrop-blur-xl">
              <div className="flex h-16 items-center gap-4 px-4 sm:px-6 lg:px-8">
                <button
                  type="button"
                  onClick={() => setDrawer(true)}
                  aria-label="Open the sections"
                  aria-expanded={drawer}
                  className="hairline inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-xl border text-soft transition-colors hover:bg-white/5 lg:hidden"
                >
                  <Icon name="dashboard" className="size-[18px]" />
                </button>
                <Link href="/" className="lg:hidden" aria-label="Tessera home">
                  <Logo size={26} />
                </Link>

                <div className="hidden min-w-0 flex-1 sm:block">
                  <SearchField />
                </div>

                <div className="ml-auto flex shrink-0 items-center gap-3">
                  <span
                    className="hairline hidden items-center gap-2 rounded-full border bg-white/[0.03] px-3.5 py-1.5 text-[12.5px] text-soft md:inline-flex"
                    title={offline ? "Simulated Airwallex, in process: no network and no money" : "The Airwallex sandbox: real API, no real money"}
                  >
                    <span aria-hidden className="size-1.5 rounded-full bg-sky" />
                    {offline ? "Offline demo" : "Airwallex sandbox"}
                  </span>
                  {health?.agent ? (
                    <span className="hairline hidden items-center gap-2 rounded-full border bg-white/[0.03] px-3.5 py-1.5 text-[12.5px] text-soft md:inline-flex">
                      <span aria-hidden className={`size-1.5 rounded-full ${agent.running ? "beat bg-blue" : "bg-[#7ee0a1]"}`} />
                      {agent.running ? `${name} working` : `${name} ready`}
                    </span>
                  ) : null}
                  <span aria-hidden className="hidden h-7 w-px bg-white/10 md:block" />
                  <span className="flex items-center gap-2.5">
                    <span
                      aria-hidden
                      className="flex size-9 items-center justify-center rounded-full border border-white/15 bg-gradient-to-br from-[#2f6ff0] to-[#0a2380] text-[12px] font-medium tracking-wide text-white"
                    >
                      {initials(health?.operator ?? "operator")}
                    </span>
                    <span className="hidden min-w-0 leading-tight sm:block">
                      <span className="block max-w-[190px] truncate text-[12.5px] text-white">{health?.operator ?? "operator"}</span>
                      <span className="block text-[11px] text-muted">Operator</span>
                    </span>
                  </span>
                </div>
              </div>

              {/* Below `sm` there is no room for the field next to the pills, so it gets its own row. */}
              <div className="flex items-center gap-3 px-4 pb-3 sm:hidden">
                <SearchField />
                <span className="hairline inline-flex shrink-0 items-center gap-2 rounded-full border bg-white/[0.03] px-3 py-1.5 text-[12px] text-soft">
                  <span aria-hidden className="size-1.5 rounded-full bg-sky" />
                  {offline ? "Offline" : "Sandbox"}
                </span>
              </div>
            </header>

            {drawer ? (
              <div className="fixed inset-0 z-50 lg:hidden">
                <button type="button" aria-label="Close the sections" onClick={() => setDrawer(false)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                <div className="absolute inset-y-0 left-0 w-[264px] border-r border-white/10 bg-[#06080f] shadow-2xl">
                  <Rail health={health} onNavigate={() => setDrawer(false)} />
                </div>
              </div>
            ) : null}

            <main className="min-w-0 flex-1">{children}</main>
          </div>
        </div>
      </div>
    </ShellProvider>
  );
}

/** The page's column: wide enough for a chart and a rail, with air either side. */
export function Stage({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1480px] px-4 pb-24 pt-7 sm:px-6 lg:px-8 ${className}`}>{children}</div>;
}

/** The page's own heading: what this is, and the controls that belong to the whole page. */
export function PageHead({ title, note, children }: { title: string; note: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0">
        <Label className="text-sky">Control room</Label>
        <h1 className="heading mt-2 text-[clamp(26px,3vw,34px)]">{title}</h1>
        <p className="mt-2 max-w-2xl text-[14px] font-light leading-relaxed text-soft">{note}</p>
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2.5">{children}</div> : null}
    </div>
  );
}
