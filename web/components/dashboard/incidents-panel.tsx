"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IncidentSummary } from "../../../src/server/wire";
import { actorLabel, agentVerdict } from "@/lib/agent-verdict";
import { ago, money } from "@/lib/format";
import { describeFailure, STATUS } from "@/lib/status";
import { moveOf } from "@/lib/next-moves";
import { AgentMark } from "../kit/agent-mark";
import { Icon } from "../landing/icons";
import { useShell } from "../shell";
import { Btn } from "../kit/metal";
import { Chip, STATUS_CHIP, Toggle, Tray, TrayHead } from "../kit/widgets";

type Filter = "all" | "live" | "you" | "certify" | "done";

const MATCH: Record<Filter, (item: IncidentSummary) => boolean> = {
  all: () => true,
  live: (item) => item.status === "PAYING" || item.status === "OPEN",
  you: (item) => item.attention !== null,
  certify: (item) => item.status === "PAID",
  done: (item) => item.status === "CLOSED",
};

/** What happens next on the invoice, and who makes the move: yours in amber, the agent's in blue, the bank's quiet. */
function Next({ item }: { item: IncidentSummary }) {
  const move = moveOf(item);
  const tone = move.who === "you" ? "text-warn font-medium" : move.who === "agent" ? "text-accent font-medium" : "text-fg/45";
  const who = move.who === "you" ? "Yours" : move.who === "agent" ? "The agent's" : null;
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-[12px] ${tone}`} title={who ? `${who}: ${move.line}` : move.line}>
      {move.who === "you" ? <Icon name="hand" className="size-3.5 shrink-0" /> : move.who === "agent" ? <AgentMark size={14} className="shrink-0 rounded-[4px]" /> : null}
      <span className="truncate">{move.label}</span>
    </span>
  );
}

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

// "Last word" needs room; below 2xl it gives way, so the columns that remain are never cut.
const COLUMNS =
  "grid-cols-[minmax(104px,0.95fr)_minmax(70px,0.5fr)_minmax(112px,0.8fr)_minmax(104px,0.9fr)_minmax(48px,0.4fr)] 2xl:grid-cols-[minmax(104px,0.95fr)_minmax(70px,0.5fr)_minmax(112px,0.75fr)_minmax(104px,0.85fr)_minmax(0,1.6fr)_minmax(48px,0.4fr)]";

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
        title="Invoices"
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
              { id: "certify", label: "To certify", count: count("certify") },
              { id: "done", label: "Certified", count: count("done") },
            ]}
          />
        }
      />
      <div role="table" aria-label="Invoices" className="tile flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px]!">
        <div role="row" className={`grid ${COLUMNS} shrink-0 items-center gap-4 border-b border-fg/[0.07] px-5 py-2.5`}>
          {["Invoice", "Amount", "Status", "Next", "Last word", "Moved"].map((head) => (
            <span key={head} role="columnheader" className={`kicker truncate ${head === "Last word" ? "hidden 2xl:block" : ""}`}>
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
                    <Next item={item} />
                  </span>
                  <span role="cell" className="hidden min-w-0 2xl:block">
                    <LastWord item={item} />
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
