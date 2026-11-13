"use client";

import { useEffect, useState } from "react";
import type { IncidentSummary, Metrics } from "../../../src/server/wire";
import { Tile, Tray, useTick } from "../kit/widgets";

/** A wall clock in a tile, after the reference's "10:24 AM, Wed 9 Sep" widget. Rendered after mount, so server and client agree. */
function Clock() {
  const now = useTick(5000);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const date = new Date(now);
  const time = mounted ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true }).replace(/\s?(AM|PM)$/i, "") : "--:--";
  const meridiem = mounted ? (date.getHours() < 12 ? "AM" : "PM") : "";
  const weekday = mounted ? date.toLocaleDateString([], { weekday: "short" }) : "";
  const day = mounted ? date.toLocaleDateString([], { day: "numeric", month: "short" }) : "";
  return (
    <Tile className="@container flex min-w-0 flex-col justify-center rounded-[22px]! px-3.5 py-3 short:py-2.5 2xl:px-4">
      <span className="readout whitespace-nowrap text-[clamp(24px,2vw,36px)] font-medium leading-none tracking-[-0.05em]">{time}</span>
      {/* AM/PM rides with the date, so the time can take the tile's whole width. */}
      <span suppressHydrationWarning className="mt-2 truncate text-[12.5px] text-fg/55 short:mt-1.5">
        {meridiem ? <span className="readout text-[11px] text-fg/70">{meridiem}</span> : null}
        {meridiem ? " · " : ""}
        {/* The weekday only where the tile is wide enough for it. */}
        {weekday ? <span className="hidden @min-[100px]:inline">{weekday}, </span> : null}
        {day}
      </span>
    </Tile>
  );
}

/** One number the room rests on, large enough to read from across a stage. */
function Count({ value, label, dot, lit = false, pulse = false }: { value: number; label: string; dot: string; lit?: boolean; pulse?: boolean }) {
  return (
    <div className="well flex min-w-0 flex-col justify-between gap-2 rounded-[20px]! px-3 py-3 short:py-2.5 2xl:px-3.5">
      <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-fg/55 2xl:text-[12px]">
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dot} ${pulse ? "beat" : ""}`} />
        <span className="truncate">{label}</span>
      </span>
      <span className={`readout text-[clamp(24px,2.1vw,36px)] font-medium leading-none tracking-[-0.04em] ${lit ? "text-warn" : ""}`}>{String(value).padStart(2, "0")}</span>
    </div>
  );
}

/**
 * The control room's masthead: the time, and the three numbers that say how the room stands. Nothing to read twice;
 * what is yours to decide turns amber the moment there is any.
 */
export function Masthead({ items, metrics, running, cardsToSign = 0 }: { items: IncidentSummary[]; metrics: Metrics | null; running: boolean; cardsToSign?: number }) {
  // Yours: incidents waiting on a person, and Visa cards waiting for a signature.
  const waiting = items.filter((item) => item.attention !== null).length + cardsToSign;
  const inFlight = items.filter((item) => item.status === "PAYING" || item.status === "OPEN").length;
  return (
    <Tray label="Control room" className="grid! grid-cols-3 gap-2 p-3 sm:grid-cols-[minmax(0,1.12fr)_repeat(3,minmax(0,1fr))] [&>:first-child]:col-span-3 sm:[&>:first-child]:col-span-1">
      <Clock />
      <Count value={waiting} label="Yours" dot="bg-warn" lit={waiting > 0} />
      <Count value={inFlight} label="In flight" dot="bg-accent" pulse={running} />
      <Count value={metrics?.certified ?? 0} label="Certified" dot="bg-fg" />
    </Tray>
  );
}
