"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IncidentSummary } from "../../../src/server/wire";
import { actorLabel, agentVerdict } from "@/lib/agent-verdict";
import { ago, money } from "@/lib/format";
import { describeFailure, STATUS } from "@/lib/status";
import { useShell } from "../shell";
import { Btn } from "../kit/metal";
import { Chip, STATUS_CHIP, Toggle, Tray, TrayHead } from "../kit/widgets";

type Filter = "all" | "live" | "you" | "done";

const MATCH: Record<Filter, (item: IncidentSummary) => boolean> = {
  all: () => true,
  live: (item) => item.status === "PAYING" || item.status === "OPEN",
  you: (item) => item.attention !== null,
  done: (item) => item.status === "CLOSED",
};

function searchable(item: IncidentSummary): string {
  return [item.reference, item.id, item.status, STATUS[item.status].label, STATUS_CHIP[item.status].label, item.method, item.currency, String(item.amountMinor / 100)].join(" ").toLowerCase();
}

/** The last word on an incident: what the agent did there, else what the bank said. */
function LastWord({ item }: { item: IncidentSummary }) {
  if (item.lastAgentAction) {
    const verdict = agentVerdict(item.lastAgentAction);
    return (
      <span className="block truncate text-[12.5px]">
        <span className={verdict.refused ? "font-medium text-bad" : "text-fg/85"}>{verdict.label}</span>
        <span suppressHydrationWarning className="text-fg/40">
          {" "}
          · {actorLabel(item.lastAgentAction.actor)}, {ago(item.lastAgentAction.at)}
        </span>
      </span>
    );
  }
  if (item.latest?.failureCode) {
    const failure = describeFailure(item.latest.failureCode);
    return (
      <span className="block truncate text-[12.5px] text-fg/80">
        {failure.name}
        <span className="text-fg/40"> · {failure.playbook}</span>
      </span>
    );
  }
  return <span className="block truncate text-[12.5px] text-fg/40">{item.latest ? `Airwallex: ${item.latest.awxStatus ?? "no word yet"}` : "Not yet sent"}</span>;
}

/** Attempts as the reference's dotted tail: one dot each, the newest coloured by where it stands. */
function Attempts({ item }: { item: IncidentSummary }) {
  const earlier = Math.max(0, item.attemptCount - 1);
  const latest = item.latest?.state;
  const tone = latest === "PAID" ? "bg-fg" : latest === "LIVE" ? "bg-accent" : latest === "DEAD" ? "bg-bad" : "bg-fg/30";
  return (
    <span className="inline-flex items-center gap-1" aria-label={`${item.attemptCount} attempt${item.attemptCount === 1 ? "" : "s"}`}>
      {Array.from({ length: earlier }, (_, i) => (
        <span key={i} className="size-[7px] rounded-full bg-fg/25" />
      ))}
      <span className={`size-[7px] rounded-full ${tone}`} />
    </span>
  );
}

const COLUMNS = "grid-cols-[minmax(124px,1fr)_minmax(78px,0.55fr)_minmax(132px,0.85fr)_minmax(0,2fr)_44px_minmax(60px,0.45fr)]";

/** Every invoice in Tessera's care, filtered by the toggle and the menubar search. Every row opens the incident. */
export function IncidentsPanel({ items, onCompose }: { items: IncidentSummary[]; onCompose: () => void }) {
  const { query, setQuery } = useShell();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const needle = query.trim().toLowerCase();
  const shown = items.filter((item) => MATCH[filter](item) && (needle === "" || searchable(item).includes(needle)));
  const count = (f: Filter) => items.filter(MATCH[f]).length;

  return (
    <Tray label="Every invoice" className="h-full p-3">
      <TrayHead
        className="px-2 pb-3 pt-1"
        title="Every invoice"
        note={needle ? `Matching “${query.trim()}”` : "Most recently moved first. Open any row for its whole story."}
        right={
          <Toggle
            label="Filter invoices"
            value={filter}
            onChange={setFilter}
            options={[
              { id: "all", label: "All", count: items.length },
              { id: "live", label: "In flight", count: count("live") },
              { id: "you", label: "Yours", count: count("you") },
              { id: "done", label: "Certified", count: count("done") },
            ]}
          />
        }
      />
      <div role="table" aria-label="Invoices" className="tile flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px]!">
        <div role="row" className={`grid ${COLUMNS} shrink-0 items-center gap-4 border-b border-fg/[0.07] px-5 py-2.5`}>
          {["Invoice", "Amount", "Status", "Last word", "Tries", "Moved"].map((head) => (
            <span key={head} role="columnheader" className="kicker truncate">
              {head}
            </span>
          ))}
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="flex h-full min-h-[110px] flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-fg/55">
              The ledger is empty. Every payout you send lands here.
              <Btn onClick={onCompose}>Send a payout</Btn>
            </div>
          ) : shown.length === 0 ? (
            <p className="px-6 py-8 text-center text-[13px] text-fg/55">
              Nothing fits that description.{" "}
              <button
                type="button"
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                }}
                className="cursor-pointer font-medium text-accent hover:underline"
              >
                Show every invoice
              </button>
            </p>
          ) : (
            shown.map((item) => {
              const chip = STATUS_CHIP[item.status];
              return (
                <div
                  key={item.id}
                  role="row"
                  onClick={() => router.push(`/incidents/${item.id}`)}
                  className={`group relative grid ${COLUMNS} cursor-pointer items-center gap-4 border-b border-fg/[0.05] px-5 py-2.5 transition-colors last:border-b-0 hover:bg-fg/[0.035] short:py-2`}
                >
                  {item.attention ? <span aria-hidden className="absolute inset-y-2.5 left-1.5 w-[3px] rounded-full bg-warn" /> : null}
                  <span role="cell" className="min-w-0">
                    <Link href={`/incidents/${item.id}`} onClick={(e) => e.stopPropagation()} className="readout block truncate text-[12.5px] font-medium group-hover:text-accent">
                      {item.reference}
                    </Link>
                    <span className="readout block text-[10px] text-fg/40">{item.method}</span>
                  </span>
                  <span role="cell" className="readout truncate text-[13px] font-medium">
                    {money(item.amountMinor, item.currency)}
                  </span>
                  <span role="cell" className="min-w-0">
                    <Chip tone={chip.tone} pulse={chip.pulse}>
                      {chip.label}
                    </Chip>
                  </span>
                  <span role="cell" className="min-w-0">
                    <LastWord item={item} />
                  </span>
                  <span role="cell">
                    <Attempts item={item} />
                  </span>
                  <span role="cell" suppressHydrationWarning className="readout truncate text-[11.5px] text-fg/45">
                    {ago(item.updatedAt)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </Tray>
  );
}
