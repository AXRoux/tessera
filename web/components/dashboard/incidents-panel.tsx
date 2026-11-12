"use client";

import { useState } from "react";
import type { IncidentSummary } from "../../../src/server/wire";
import { STATUS } from "@/lib/status";
import { useShell } from "../shell";
import { IncidentTable } from "../incidents-table";
import { Label } from "../ui";

const FILTERS = ["All", "Live", "With a person", "Certified"] as const;
type Filter = (typeof FILTERS)[number];

const MATCH: Record<Filter, (item: IncidentSummary) => boolean> = {
  All: () => true,
  Live: (item) => item.status === "PAYING" || item.status === "OPEN",
  "With a person": (item) => item.attention !== null,
  Certified: (item) => item.status === "CLOSED",
};

/** Reference, status, method, amount or id: what an operator would type into a search box. */
function searchable(item: IncidentSummary): string {
  return [item.reference, item.id, item.status, STATUS[item.status].label, item.method, item.currency, String(item.amountMinor / 100)].join(" ").toLowerCase();
}

/** The whole board as a table, narrowed by the filter chips and by the search field in the topbar. */
export function IncidentsPanel({ items, onSeed, seeding, canSeed }: { items: IncidentSummary[]; onSeed: () => void; seeding: boolean; canSeed: boolean }) {
  const { query } = useShell();
  const [filter, setFilter] = useState<Filter>("All");
  const needle = query.trim().toLowerCase();
  const shown = items.filter((item) => MATCH[filter](item) && (needle === "" || searchable(item).includes(needle)));

  return (
    <section id="incidents" data-shell-section className="panel min-w-0 overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-white/[0.075] px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-medium tracking-[-0.01em]">Incidents</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Every invoice Tessera is holding, newest movement first. Press <kbd className="rounded border border-white/15 px-1 text-[11px]">/</kbd> to search.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setFilter(name)}
              aria-pressed={filter === name}
              className={`cursor-pointer rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors ${
                filter === name ? "border-transparent bg-white text-black" : "border-white/[0.12] text-soft hover:bg-white/[0.06]"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      </header>

      {items.length > 0 && shown.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13.5px] text-muted">
          Nothing matches {needle === "" ? `“${filter}”` : `“${query.trim()}”`}. <button type="button" onClick={() => setFilter("All")} className="cursor-pointer text-sky underline underline-offset-4">Show everything</button>.
        </p>
      ) : (
        <IncidentTable
          items={shown}
          empty={
            canSeed ? (
              <span className="flex flex-col items-center gap-3">
                No incidents yet. Seven invoices, each broken in a different way, are one button away.
                <button
                  type="button"
                  onClick={onSeed}
                  disabled={seeding}
                  className="cursor-pointer rounded-full bg-white px-4 py-2 text-[13px] text-black disabled:opacity-60"
                >
                  {seeding ? "Loading…" : "Load the incidents"}
                </button>
              </span>
            ) : (
              "No incidents yet."
            )
          }
        />
      )}

      {shown.length > 0 ? (
        <footer className="flex items-center justify-between gap-4 border-t border-white/[0.075] px-5 py-3">
          <Label className="tnum">
            {shown.length} of {items.length} shown
          </Label>
          <Label>Every row opens the full incident: evidence, actions and the hash-chained history</Label>
        </footer>
      ) : null}
    </section>
  );
}
