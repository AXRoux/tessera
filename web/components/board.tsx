"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Acknowledged, api, ApiProblem } from "@/lib/client-api";
import { ago, duration, money } from "@/lib/format";
import { ATTEMPT, describeFailure, SQUARE, STATUS } from "@/lib/status";
import { IncidentListSchema, MetricsSchema, SeedResultSchema, type Health, type IncidentSummary, type Metrics } from "../../src/server/wire";
import { AgentTimeline, agentName, useAgentRun } from "./agent/agent-run";
import { Logo } from "./logo";
import { Button, Frame, Label, PanelHeader, Stat, StatStrip, Tag } from "./ui";

const POLL_MS = 4000;

/** Earlier attempts must have ended (they were replaced), so only the latest one can still be moving. */
function AttemptSquares({ item }: { item: IncidentSummary }) {
  const earlier = Math.max(0, item.attemptCount - 1);
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={`${item.attemptCount} attempt${item.attemptCount === 1 ? "" : "s"}`}>
      {Array.from({ length: earlier }, (_, i) => (
        <span key={i} className="size-3 bg-ink" />
      ))}
      {item.latest ? <span className={`size-3 ${SQUARE[item.latest.state]}`} /> : <span className="size-3 border border-rule" />}
    </span>
  );
}

function FailureCell({ item }: { item: IncidentSummary }) {
  if (!item.latest) return <span className="text-muted">None</span>;
  if (!item.latest.failureCode) return <span className="text-muted">{ATTEMPT[item.latest.state].label}</span>;
  const failure = describeFailure(item.latest.failureCode);
  return (
    <span className="block leading-snug">
      <span className="block font-medium">{failure.name}</span>
      <span className="block text-xs text-muted">
        {failure.playbook} &middot; <span className="font-mono">{item.latest.failureCode}</span>
      </span>
    </span>
  );
}

/** Refused money, per currency. Several currencies are listed side by side; nothing refused reads as zero. */
function heldBack(metrics: Metrics): string {
  const lines = Object.entries(metrics.refusedAmountMinor).filter(([, minor]) => minor > 0);
  if (lines.length === 0) return money(0, "USD");
  return lines.map(([currency, minor]) => money(minor, currency)).join(" + ");
}

/** The numbers a judge asks for first, all derived from ledger events by the API. Dashes while they cannot be read. */
function MetricsStrip({ metrics, awaiting }: { metrics: Metrics | null; awaiting: number }) {
  const value = <T,>(read: (m: Metrics) => T) => (metrics ? read(metrics) : "\u2014");
  return (
    <StatStrip columns={6}>
      <Stat value={value((m) => m.incidents)} label="Invoices tracked" />
      <Stat value={value((m) => m.paymentsRefused)} label="Payments refused by code" />
      <Stat value={value(heldBack)} label="Money held back" />
      <Stat value={value((m) => m.autoReplaced)} label="Replaced automatically" />
      <Stat value={value((m) => (m.medianResolutionMs === null ? "\u2014" : duration(m.medianResolutionMs)))} label="Median time to certify" />
      <Stat value={awaiting} label="Awaiting a person" />
    </StatStrip>
  );
}

export function Board({ initial, initialMetrics, health }: { initial: IncidentSummary[]; initialMetrics: Metrics | null; health: Health | null }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [metrics, setMetrics] = useState(initialMetrics);
  const [creating, setCreating] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Each read stands alone: a failed one keeps the last good value and the next poll retries.
    const [list, numbers] = await Promise.allSettled([api("obligations", IncidentListSchema), api("metrics", MetricsSchema)]);
    if (list.status === "fulfilled") setItems(list.value.items);
    if (numbers.status === "fulfilled") setMetrics(numbers.value);
  }, []);

  const agent = useAgentRun(() => void refresh());

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const created = await api("obligations", Acknowledged, { method: "POST", body: { amount: 25 } });
      const id = typeof created.id === "string" ? created.id : null;
      if (id) router.push(`/incidents/${id}`);
      else await refresh();
    } catch (e) {
      setError(e instanceof ApiProblem ? e.problem.message : "The test invoice could not be created.");
    } finally {
      setCreating(false);
    }
  }

  async function seed() {
    setSeeding(true);
    setError(null);
    setSeeded(null);
    try {
      const result = await api("demo/seed", SeedResultSchema, { method: "POST" });
      setSeeded(`Opened ${result.seeded.length} demo incident${result.seeded.length === 1 ? "" : "s"}: ${result.seeded.map((s) => s.reference).join(", ")}.`);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiProblem ? e.problem.message : "The demo incidents could not be created.");
    } finally {
      setSeeding(false);
    }
  }

  const awaiting = items.filter((i) => i.status === "ESCALATED" || i.status === "NEEDS_ACTION").length;
  const canSeed = Boolean(health && (health.offline || health.sandbox));
  const name = agentName(health?.agent);
  const Name = agentName(health?.agent, true);
  const agentReady = Boolean(health?.agent) && items.length > 0;
  const runningMode = agent.running ? agent.state.mode : null;

  return (
    <>
      {health?.offline ? (
        <div className="border-y border-blue bg-wash">
          <p className="mx-auto flex max-w-[1440px] items-center gap-3 px-6 py-3 text-sm sm:px-10">
            <span aria-hidden className="size-2 shrink-0 bg-blue" />
            {health.agent === "claude"
              ? "Offline demo: simulated Airwallex, agent runs by Claude. No money and no bank are involved."
              : "Offline demo: simulated Airwallex, scripted agent. The agent here is a deterministic script, not Claude."}
          </p>
        </div>
      ) : null}

      <MetricsStrip metrics={metrics} awaiting={awaiting} />

      <section aria-labelledby="incidents" className="mx-auto max-w-[1440px] px-6 pt-14 sm:px-10">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <Label>Live ledger</Label>
            <h2 id="incidents" className="mt-4 font-display text-3xl tracking-wide sm:text-4xl">
              Incidents
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {health ? (
              <span className="hidden items-center gap-3 sm:flex">
                <Tag tone={health.agent ? "blue-outline" : "muted"}>
                  {health.agent === "claude" ? "Claude connected" : health.agent === "scripted" ? "Scripted agent, not Claude" : "No agent connected"}
                </Tag>
                <Tag tone={health.sandbox ? "blue-outline" : "muted"}>
                  {health.offline ? "Simulated Airwallex" : health.sandbox ? "Simulator on" : "Simulator off"}
                </Tag>
              </span>
            ) : null}
            <Button
              variant="secondary"
              disabled={!agentReady || agent.running}
              busy={runningMode === "commander"}
              onClick={() => agent.start(null)}
            >
              {runningMode === "commander" ? `${Name} is working` : `Let ${name} work them all`}
            </Button>
            {health?.sandbox ? (
              <Button
                variant="secondary"
                disabled={!agentReady || agent.running}
                busy={runningMode === "adversary"}
                onClick={() => agent.start(null, "adversary")}
              >
                {runningMode === "adversary" ? `${Name} is attacking` : "Try to break it"}
              </Button>
            ) : null}
            {canSeed ? (
              <Button variant="secondary" onClick={seed} busy={seeding}>
                Seed demo incidents
              </Button>
            ) : null}
            <Button onClick={create} busy={creating}>
              Send a test invoice
            </Button>
          </div>
        </div>

        {agent.state.status !== "idle" ? (
          <div className="mt-8">
            <Frame tone="blue">
              <PanelHeader
                title={agent.state.mode === "adversary" ? "Adversary agent" : "Commander agent"}
                right={
                  <span className="flex items-center gap-4">
                    {agent.target ? (
                      <Link href={`/incidents/${agent.target}`} className="label text-ink underline decoration-rule underline-offset-4 hover:text-blue">
                        One incident
                      </Link>
                    ) : null}
                    {agent.running ? (
                      <button type="button" onClick={agent.stop} className="label cursor-pointer text-ink hover:text-blue">
                        Stop
                      </button>
                    ) : null}
                    <Label className={agent.state.mode === "adversary" ? "text-ink" : "text-blue"}>{agent.state.actor ?? Name}</Label>
                  </span>
                }
              />
              <AgentTimeline state={agent.state} />
            </Frame>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="mt-6 border border-ink px-5 py-4 text-sm">
            {error}
          </p>
        ) : null}
        {seeded ? (
          <p role="status" className="mt-6 border border-blue bg-wash px-5 py-4 text-sm">
            {seeded}
          </p>
        ) : null}

        {items.length === 0 ? (
          <div className="mt-10">
            <Frame>
              <div className="hatch grid place-items-center gap-6 px-6 py-20 text-center">
                <Logo size={44} />
                <p className="font-display text-2xl tracking-wide">No open payments</p>
                <p className="max-w-md text-sm text-muted">
                  {canSeed
                    ? "Seed the demo incidents to see every branch of the playbook at once, or send a single test invoice. Tessera records the payment instruction before any money moves."
                    : "Send a test invoice to open your first incident. Tessera records the payment instruction before any money moves."}
                </p>
                <div className="flex flex-wrap justify-center gap-4">
                  {canSeed ? (
                    <Button variant="secondary" onClick={seed} busy={seeding}>
                      Seed demo incidents
                    </Button>
                  ) : null}
                  <Button onClick={create} busy={creating}>
                    Send a test invoice
                  </Button>
                </div>
              </div>
            </Frame>
          </div>
        ) : (
          <div className="mt-10 overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-left">
              <thead>
                <tr className="border-b border-ink">
                  {["Invoice", "Amount", "Status", "Attempts", "Latest failure", "Updated"].map((h) => (
                    <th key={h} className="label h-11 pr-6 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const status = STATUS[item.status];
                  return (
                    <tr key={item.id} className="group relative border-b border-rule transition-colors hover:bg-wash">
                      <td className="relative h-[68px] pr-6">
                        <span aria-hidden className="absolute inset-y-0 -left-px w-1 bg-transparent group-hover:bg-blue" />
                        <Link href={`/incidents/${item.id}`} className="font-mono text-[13px] font-medium after:absolute after:inset-0">
                          {item.reference}
                        </Link>
                      </td>
                      <td className="tnum pr-6 text-[15px] font-semibold">{money(item.amountMinor, item.currency)}</td>
                      <td className="pr-6">
                        <Tag tone={status.tone} pulse={status.pulse}>
                          {status.label}
                        </Tag>
                      </td>
                      <td className="pr-6">
                        <AttemptSquares item={item} />
                      </td>
                      <td className="py-3 pr-6 text-sm">
                        <FailureCell item={item} />
                      </td>
                      <td className="text-sm text-muted">{ago(item.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
