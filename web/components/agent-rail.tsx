"use client";

import Link from "next/link";
import { agentName, useAgentRun } from "./agent/agent-run";
import type { Health, IncidentSummary, Metrics } from "../../src/server/wire";
import { reasonText } from "@/lib/agent-verdict";
import { needsYou } from "@/lib/tour-steps";
import { Button, Label, Tag } from "./ui";

/**
 * The right-hand rail: the one place the run is controlled and the one place work comes back to a person.
 *
 * Research is consistent that a supervised agent run needs three surfaces: the transcript (what it is doing),
 * a live status line (is it still alive), and the escalation path (what now needs me). This is the second and
 * third, kept next to the transcript so an escalation is never a page away from the step that caused it.
 */
export function AgentRail({ health, metrics, items, awaiting, onSeed, canSeed, seeding }: {
  health: Health | null;
  metrics: Metrics | null;
  items: IncidentSummary[];
  awaiting: number;
  onSeed: () => void;
  canSeed: boolean;
  seeding: boolean;
}) {
  const agent = useAgentRun();
  const name = agentName(health?.agent);
  const Name = agentName(health?.agent, true);
  const available = Boolean(health?.agent);
  const waiting = needsYou(items);
  const live = agent.running;
  const last = agent.state.steps.findLast((s) => s.kind === "tool");
  const refused = agent.state.done?.refused ?? agent.state.steps.filter((s) => s.kind === "tool" && s.result?.kind === "refused").length;

  const control = live ? (
    <>
      <Button variant="secondary" onClick={agent.stop} className="w-full">
        Stop
      </Button>
      <p aria-live="polite" className="flex items-start gap-2.5 text-[13px] leading-snug text-soft">
        <span aria-hidden className="beat mt-1.5 size-2 shrink-0 rounded-full bg-blue" />
        {last ? <>Working: {last.tool.replaceAll("_", " ")}</> : "Starting…"} &middot; {agent.state.done?.calls ?? agent.state.steps.filter((s) => s.kind === "tool").length} calls
      </p>
    </>
  ) : (
    <>
      <Button className="w-full" disabled={!available || items.length === 0} onClick={() => agent.start(null)}>
        Let {name} work them all
      </Button>
      {health?.sandbox ? (
        <Button variant="secondary" className="w-full" disabled={!available || items.length === 0} onClick={() => agent.start(null, "adversary")}>
          Try to break it
        </Button>
      ) : null}
    </>
  );

  return (
    <aside className="flex flex-col gap-4">
      <section className="card p-5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[15px] font-medium tracking-[-0.01em]">Agent</span>
          <Tag tone={available ? "blue-outline" : "muted"} pulse={live}>
            {available ? (live ? "Working" : "Ready") : "Not configured"}
          </Tag>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {health?.agent?.kind === "scripted"
            ? "The offline agent is a deterministic script, not a model. Same tools, same refusals."
            : `Ten typed tools. ${Name} reads, asks and drafts; the code decides.`}
        </p>
        <div className="mt-4 flex flex-col gap-2.5">{control}</div>
        {agent.state.status !== "idle" ? (
          <dl className="tnum mt-4 grid grid-cols-3 gap-2 border-t border-rule pt-4 text-center">
            {[
              ["Calls", agent.state.steps.filter((s) => s.kind === "tool").length],
              ["Refused", refused],
              ["Handed on", agent.state.steps.filter((s) => s.kind === "tool" && s.result?.ok && (s.tool === "escalate_to_human" || s.tool === "draft_supplier_reply")).length],
            ].map(([label, value]) => (
              <div key={label}>
                <dd className="text-[20px] font-light leading-none">{value}</dd>
                <dt className="mt-1.5 text-[11px] text-muted">{label}</dt>
              </div>
            ))}
          </dl>
        ) : null}
      </section>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-rule px-5 py-3.5">
          <span className="text-[15px] font-medium tracking-[-0.01em]">Needs you</span>
          <Label className="tnum">{waiting.length}</Label>
        </div>
        {waiting.length === 0 ? (
          <p className="px-5 py-4 text-[13px] leading-relaxed text-muted">
            Nothing is waiting for a person yet. {items.length === 0 ? "Load the incidents to begin." : `Run ${name}; anything it cannot settle safely lands here.`}
          </p>
        ) : (
          <ul className="divide-y divide-rule">
            {waiting.map((item) => (
              <li key={item.id} className="px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <Link href={`/incidents/${item.id}`} className="font-mono text-[13px] hover:text-sky">
                    {item.reference}
                  </Link>
                  <Tag tone={item.attention.kind === "ESCALATED" ? "ink" : "blue-outline"}>
                    {item.attention.kind === "ESCALATED" ? "Handed to you" : item.attention.kind === "DRAFT" ? "Reply to send" : "Decision"}
                  </Tag>
                </div>
                <p className="mt-2 line-clamp-2 text-[13px] leading-snug text-muted">{reasonText(item.attention.reason)}</p>
                <Link
                  href={`/incidents/${item.id}`}
                  className="mt-3 inline-flex h-9 items-center rounded-full border border-white/30 px-4 text-[13px] transition-colors hover:bg-white/10"
                >
                  Review
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canSeed && items.length === 0 ? (
        <section className="glow-card p-5">
          <p className="text-[15px] font-medium">Nothing on the board yet</p>
          <p className="mt-2 text-[13px] leading-relaxed text-white/85">
            Seven invoices, each broken in a different way: one still in flight, one timed out, one possible duplicate, one bank-detail change, one already paid, one disputed, one short of cash.
          </p>
          <Button variant="light" className="mt-4 w-full" onClick={onSeed} busy={seeding}>
            Load seven incidents
          </Button>
        </section>
      ) : null}

      {metrics ? (
        <section className="card px-5 py-4">
          <Label>This board</Label>
          <dl className="mt-3 space-y-2 text-[13px]">
            {[
              ["Invoices tracked", metrics.incidents],
              ["Payments refused by code", metrics.paymentsRefused],
              ["Replaced automatically", metrics.autoReplaced],
              ["Certified", metrics.certified],
              ["Awaiting a person", awaiting],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3">
                <dt className="text-muted">{label}</dt>
                <dd className="tnum">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </aside>
  );
}
