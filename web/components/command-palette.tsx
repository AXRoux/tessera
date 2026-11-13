"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CardsSchema, IncidentListSchema, type CardView, type IncidentSummary } from "../../src/server/wire";
import { api } from "@/lib/client-api";
import { money } from "@/lib/format";
import { OPEN_CARD, OPEN_CARD_COMPOSER } from "@/lib/use-cards";
import { useTheme } from "./kit/theme";
import { Icon } from "./landing/icons";

interface Command {
  id: string;
  group: "Actions" | "Go to" | "Incidents" | "Visa cards";
  label: string;
  hint?: string;
  icon: ReactNode;
  /** Extra words the search matches on. */
  keywords?: string;
  run: () => void;
}

const isMac = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The key hint as this machine writes it: ⌘K on a Mac, Ctrl K elsewhere. Rendered after mount, so server and client agree. */
export function useShortcutLabel(): string {
  const [label, setLabel] = useState("⌘K");
  useEffect(() => setLabel(isMac() ? "⌘K" : "Ctrl K"), []);
  return label;
}

/**
 * ⌘K (Ctrl K elsewhere, or /) from anywhere: jump to an incident or a card, run an action, or filter the board. The
 * menubar's search well opens it too. Arrow keys move, Enter runs, Escape closes.
 */
export function CommandPalette({ open, onClose, query, setQuery, accounts }: { open: boolean; onClose: () => void; query: string; setQuery: (q: string) => void; accounts: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [cards, setCards] = useState<CardView[]>([]);

  useEffect(() => {
    if (!open) return;
    setText(query);
    setActive(0);
    requestAnimationFrame(() => input.current?.select());
    void api("obligations", IncidentListSchema).then((l) => setIncidents(l.items)).catch(() => undefined);
    void api("cards", CardsSchema).then((c) => setCards(c.items)).catch(() => undefined);
  }, [open, query]);

  const onDashboard = pathname === "/dashboard";
  const go = useCallback(
    (fn: () => void) => () => {
      onClose();
      fn();
    },
    [onClose],
  );

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [
      {
        id: "card", group: "Actions", label: "Issue a Visa card", hint: "Airwallex · single use", keywords: "visa virtual card new request spend",
        icon: <Icon name="wallet" className="size-4" />,
        run: go(() => (onDashboard ? window.dispatchEvent(new Event(OPEN_CARD_COMPOSER)) : router.push("/dashboard?card=new"))),
      },
      {
        id: "payout", group: "Actions", label: "Send a payout", hint: "Airwallex transfer", keywords: "pay transfer invoice new",
        icon: <Icon name="arrow" className="size-4" />,
        run: go(() => router.push("/dashboard?compose=1")),
      },
      {
        id: "theme", group: "Actions", label: theme === "dark" ? "Switch to light" : "Switch to dark", keywords: "theme appearance mode",
        icon: <Icon name={theme === "dark" ? "sun" : "moon"} className="size-4" />,
        run: go(() => setTheme(theme === "dark" ? "light" : "dark")),
      },
      { id: "dashboard", group: "Go to", label: "Control room", keywords: "dashboard board home", icon: <Icon name="dashboard" className="size-4" />, run: go(() => router.push("/dashboard")) },
      { id: "queue", group: "Go to", label: "The queue", hint: "Waiting on you", keywords: "inbox decisions", icon: <Icon name="hand" className="size-4" />, run: go(() => router.push("/queue")) },
      ...(accounts ? [{ id: "workspace", group: "Go to" as const, label: "Workspace and keys", keywords: "settings airwallex model keys", icon: <Icon name="lock" className="size-4" />, run: go(() => router.push("/workspace")) }] : []),
      { id: "landing", group: "Go to", label: "Tessera home", keywords: "landing", icon: <Icon name="back" className="size-4" />, run: go(() => router.push("/")) },
    ];
    for (const card of cards.slice(0, 12)) {
      out.push({
        id: `card-${card.id}`, group: "Visa cards", label: `${card.merchant} · ${card.purpose}`,
        hint: `${card.state.toLowerCase()} · ${money(card.amountMinor, card.currency)}${card.last4 ? ` · ${card.last4}` : ""}`,
        keywords: `visa card ${card.state} ${card.last4 ?? ""} ${card.categoryLabel}`,
        icon: <Icon name="wallet" className="size-4" />,
        run: go(() => (onDashboard ? window.dispatchEvent(new CustomEvent(OPEN_CARD, { detail: card.id })) : router.push("/dashboard"))),
      });
    }
    for (const incident of incidents) {
      out.push({
        id: `incident-${incident.id}`, group: "Incidents", label: incident.reference,
        hint: `${incident.status.toLowerCase().replace("_", " ")} · ${money(incident.amountMinor, incident.currency)}`,
        keywords: `${incident.status} ${incident.currency}`,
        icon: <Icon name="file" className="size-4" />,
        run: go(() => router.push(`/incidents/${incident.id}`)),
      });
    }
    return out;
  }, [cards, incidents, theme, setTheme, accounts, go, router, onDashboard]);

  const needle = text.trim().toLowerCase();
  const shown = useMemo(() => {
    const matched = needle ? commands.filter((c) => `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(needle)) : commands.filter((c) => c.group !== "Incidents" || commands.indexOf(c) < 40);
    // Filtering the board is always on offer for typed text, and first when nothing else matches.
    const filter: Command | null = needle
      ? { id: "filter", group: "Actions", label: `Filter the board for “${text.trim()}”`, icon: <Icon name="search" className="size-4" />, run: go(() => {
            setQuery(text.trim());
            if (pathname !== "/dashboard" && pathname !== "/queue") router.push("/dashboard");
          }) }
      : null;
    return filter ? [...matched, filter] : matched;
  }, [commands, needle, text, go, setQuery, pathname, router]);

  useEffect(() => setActive(0), [needle]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;
  const groups = [...new Set(shown.map((c) => c.group))];

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-canvas/55 p-4 pt-[12vh] backdrop-blur-md" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-label="Command palette" className="tray flex max-h-[70vh] w-full max-w-[620px] flex-col overflow-hidden bg-canvas! p-2">
        <div className="well flex items-center gap-3 rounded-full! px-4">
          <Icon name="search" className="size-4 shrink-0 text-fg/45" />
          <input
            ref={input}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((i) => Math.min(i + 1, shown.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                shown[active]?.run();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder="Jump to an invoice or a card, or run an action"
            aria-label="Search commands"
            aria-activedescendant={shown[active] ? `cmd-${shown[active]!.id}` : undefined}
            className="h-12 w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-fg/40"
          />
          <kbd className="readout shrink-0 rounded-md border border-fg/15 px-1.5 text-[10.5px] text-fg/45">esc</kbd>
        </div>
        <ul ref={list} role="listbox" aria-label="Results" className="thin-scroll mt-2 min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          {shown.length === 0 ? <li className="px-3 py-6 text-center text-[13px] text-fg/50">Nothing matches.</li> : null}
          {groups.map((group) => (
            <li key={group} role="presentation">
              <p className="kicker px-3 pb-1 pt-2.5">{group}</p>
              <ul role="presentation">
                {shown
                  .map((command, index) => ({ command, index }))
                  .filter(({ command }) => command.group === group)
                  .map(({ command, index }) => (
                    <li
                      key={command.id}
                      id={`cmd-${command.id}`}
                      role="option"
                      aria-selected={index === active}
                      data-index={index}
                      onMouseMove={() => setActive(index)}
                      onClick={command.run}
                      className={`flex cursor-pointer items-center gap-3 rounded-[14px] px-3 py-2.5 ${index === active ? "tile rounded-[14px]!" : ""}`}
                    >
                      <span className={`flex size-8 shrink-0 items-center justify-center rounded-[10px] ${index === active ? "bg-accent text-white" : "well rounded-[10px]! text-fg/60"}`}>{command.icon}</span>
                      <span className="min-w-0 flex-1 truncate text-[13.5px]">{command.label}</span>
                      {command.hint ? <span className="readout shrink-0 truncate text-[11px] text-fg/45">{command.hint}</span> : null}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
