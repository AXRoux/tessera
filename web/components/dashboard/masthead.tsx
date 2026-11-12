"use client";

import { useEffect, useState } from "react";
import type { Health, IncidentSummary, Metrics } from "../../../src/server/wire";
import { Kicker, Tile, Tray, useTick } from "../kit/widgets";

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** The state of the room in one sentence, so a glance from across the stage is enough. */
function headline(items: IncidentSummary[], waiting: number, running: boolean): string {
  if (running) return "The agent is working the board.";
  if (items.length === 0) return "A quiet ledger, ready for its first payout.";
  if (waiting === 1) return "One decision awaits you.";
  if (waiting > 1) return `${WORDS[waiting] ?? waiting} decisions await you.`;
  return "Everything is accounted for.";
}

/** A wall clock in a tile, after the reference's "10:24 AM, Wed 9 Sep" widget. Rendered after mount, so server and client agree. */
function Clock() {
  const now = useTick(5000);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const date = new Date(now);
  const time = mounted ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true }).replace(/\s?(AM|PM)$/i, "") : "--:--";
  const meridiem = mounted ? (date.getHours() < 12 ? "AM" : "PM") : "";
  const day = mounted ? date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) : "";
  return (
    <Tile className="flex w-[132px] shrink-0 flex-col justify-center rounded-[22px]! px-4 py-3 short:w-[118px] short:py-2">
      <span className="flex items-baseline gap-1">
        <span className="readout text-[30px] font-medium leading-none tracking-[-0.05em] short:text-[26px]">{time}</span>
        <span className="readout text-[10px] text-fg/50">{meridiem}</span>
      </span>
      <span suppressHydrationWarning className="mt-1.5 text-[12.5px] text-fg/55">
        {day}
      </span>
    </Tile>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <span className="well inline-flex h-7 items-center gap-1.5 rounded-full! pl-2 pr-2.5">
      <span aria-hidden className={`size-1.5 rounded-full ${tone}`} />
      <span className="readout text-[12px] font-medium">{String(value).padStart(2, "0")}</span>
      <span className="text-[11.5px] text-fg/55">{label}</span>
    </span>
  );
}

/**
 * The control room's masthead: a clock tile, the state of the room as one sentence, and the three numbers that sentence
 * rests on. Replaces a paragraph of explanation with things a person can read at a glance.
 */
export function Masthead({ items, metrics, running, health }: { items: IncidentSummary[]; metrics: Metrics | null; running: boolean; health: Health | null }) {
  const waiting = items.filter((item) => item.attention !== null).length;
  const inFlight = items.filter((item) => item.status === "PAYING" || item.status === "OPEN").length;
  return (
    <Tray label="Control room" className="flex-row! items-stretch gap-3 p-3">
      <Clock />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 px-1 py-1">
        <Kicker className="flex items-center gap-1.5">
          <span aria-hidden className={`size-1.5 rounded-full ${running ? "beat bg-accent" : "bg-accent"}`} />
          Control room · {health?.offline ? "offline rehearsal" : "live from Airwallex"}
        </Kicker>
        <h1 className="truncate text-[clamp(20px,1.75vw,28px)] font-semibold leading-[1.1] tracking-[-0.04em]">{headline(items, waiting, running)}</h1>
        <div className="flex flex-wrap gap-1.5">
          <Stat value={waiting} label="yours" tone="bg-warn" />
          <Stat value={inFlight} label="in flight" tone="bg-accent" />
          <Stat value={metrics?.certified ?? 0} label="certified" tone="bg-fg" />
        </div>
      </div>
    </Tray>
  );
}
