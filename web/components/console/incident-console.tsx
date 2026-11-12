"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useIncident } from "@/lib/use-incident";
import { money } from "@/lib/format";
import { viewNeedsPerson } from "@/lib/tour-steps";
import type { Health, IncidentView } from "../../../src/server/wire";
import { AgentPanel } from "../agent/agent-panel";
import { useAgentRun } from "../agent/agent-run";
import { Icon } from "../landing/icons";
import { MetalCircle } from "../kit/metal";
import { Chip, Kicker, STATUS_CHIP, Tile, Toggle, Tray, TrayHead } from "../kit/widgets";
import { Workspace } from "../shell";
import { markTakeoverOpened } from "../tour";
import { ActionsPanel } from "./actions-panel";
import { AttemptsRail } from "./attempts-rail";
import { CertificatePanel } from "./certificate-panel";
import { DecisionPanel } from "./decision-panel";
import { EvidencePanel } from "./evidence-panel";
import { NoticeBox } from "./fields";
import { InboxPanel } from "./inbox-panel";
import { LedgerLog } from "./ledger-log";
import { SandboxPanel } from "./sandbox-panel";

function Figure({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <Tile className="min-w-[96px] rounded-[18px]! px-4 py-2.5">
      <Kicker>{label}</Kicker>
      <dd className={`readout mt-1 truncate text-[16px] font-medium tracking-[-0.02em] ${tone}`}>{value}</dd>
    </Tile>
  );
}

type Evidence = "history" | "attempts" | "supplier" | "certificate";
type Move = "decide" | "agent" | "simulate";

/**
 * One incident, composed to fit one screen and read in order, left to right: 01 the situation and what Tessera
 * recommends, 02 the evidence behind it, 03 your move, by your own hand or the agent's. Panels scroll inside
 * themselves; the page does not grow.
 */
export function IncidentConsole({ initial, health }: { initial: IncidentView; health: Health | null }) {
  const id = initial.obligation.id;
  const { view: live, busy, notice, setNotice, run, refresh } = useIncident(id, initial);
  const view = live ?? initial;
  const agent = useAgentRun();
  const needsPerson = viewNeedsPerson(view);
  const [evidence, setEvidence] = useState<Evidence>("history");
  const [move, setMove] = useState<Move>(needsPerson || !health?.agent ? "decide" : "agent");

  // The walkthrough's "take over" step is done once the operator has looked at an incident that was waiting for them.
  useEffect(() => {
    if (needsPerson) markTakeoverOpened();
  }, [needsPerson]);

  // When a run starts on this incident, bring its transcript forward.
  const mine = agent.running && agent.target === id;
  useEffect(() => {
    if (mine) setMove("agent");
  }, [mine]);

  const o = view.obligation;
  const chip = STATUS_CHIP[o.status];
  const feesKept = view.attempts.reduce((sum, a) => sum + (a.feeMinor ?? 0), 0);
  const delivered = view.attempts.filter((a) => a.state === "PAID").reduce((sum, a) => sum + a.amountMinor, 0);
  // Who reads supplier messages, as the server names it: the configured model, or offline the keyword reader (not a model).
  const reader = health?.reader ?? null;
  const operator = health?.operator ?? "operator";

  return (
    <Workspace>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <div className="flex min-w-0 items-center gap-4">
          <MetalCircle href="/queue" label="Back to the queue">
            <Icon name="back" className="size-[18px]" />
          </MetalCircle>
          <div className="min-w-0">
            <Kicker>Incident</Kicker>
            <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
              <h1 className="readout text-[clamp(20px,1.7vw,26px)] font-medium leading-none tracking-[-0.03em]">{o.reference}</h1>
              <Chip tone={chip.tone} pulse={chip.pulse}>
                {chip.label}
              </Chip>
              <span title={view.chain.ok ? "Every ledger entry is sealed to the one before it, and the chain checks out." : `The chain breaks at entry ${view.chain.brokenAt}.`}>
                <Chip tone={view.chain.ok ? "accent" : "bad"}>{view.chain.ok ? "History intact" : "History altered"}</Chip>
              </span>
            </div>
          </div>
        </div>

        <dl className="flex flex-wrap items-stretch gap-2">
          <Figure label="Owed" value={money(o.amountMinor, o.currency)} />
          <Figure label="Delivered" value={money(delivered, o.currency)} tone={delivered > 0 ? "text-accent" : "text-fg/60"} />
          <Figure label="Tries" value={String(view.attempts.length).padStart(2, "0")} />
          <Figure label="Fees kept" value={money(feesKept, o.currency)} />
          <Figure label="Rail" value={`${o.method} ${o.currency}`} />
        </dl>
      </header>

      <div className="grid min-h-0 gap-4 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(340px,390px)] 2xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)_430px]">
        <div className="flex min-h-[520px] flex-col xl:min-h-0 [&>section]:flex-1">
          <DecisionPanel view={view} />
        </div>

        <Tray label="The evidence" className="min-h-[560px] gap-3 p-3 xl:min-h-0">
          <TrayHead className="px-2 pt-1" n={2} title="The evidence" note="What the ledger, the bank and the supplier say" />
          <div className="shrink-0 px-1">
            <Toggle
              label="Evidence"
              value={evidence}
              onChange={setEvidence}
              className="w-fit"
              options={[
                { id: "history", label: "History", count: view.events.length },
                { id: "attempts", label: "Attempts", count: view.attempts.length },
                { id: "supplier", label: "Supplier", count: view.inbox.length },
                { id: "certificate", label: "Certificate" },
              ]}
            />
          </div>
          <div role="tabpanel" className="thin-scroll min-h-0 flex-1 overflow-y-auto p-1">
            {evidence === "history" ? <LedgerLog events={view.events} chain={view.chain} /> : null}
            {evidence === "attempts" ? <AttemptsRail attempts={view.attempts} /> : null}
            {evidence === "supplier" ? (
              <div className="space-y-5">
                <EvidencePanel view={view} reader={reader} busy={busy} run={run} />
                <InboxPanel view={view} reader={reader} busy={busy} run={run} />
              </div>
            ) : null}
            {evidence === "certificate" ? <CertificatePanel view={view} /> : null}
          </div>
        </Tray>

        <Tray label="Your move" className="min-h-[620px] gap-3 p-3 xl:min-h-0">
          <TrayHead
            className="px-2 pt-1"
            n={3}
            title="Your move"
            note={needsPerson ? "This one is waiting on you" : "By your own hand, or the agent’s"}
            right={needsPerson ? <Chip tone="warn" pulse>Yours</Chip> : null}
          />
          <div className="shrink-0 px-1">
            <Toggle
              label="Your move"
              value={move}
              onChange={setMove}
              className="w-fit"
              options={[
                { id: "decide" as Move, label: "Decide" },
                { id: "agent" as Move, label: "Ask the agent" },
                ...(health?.sandbox ? [{ id: "simulate" as Move, label: "Simulate" }] : []),
              ]}
            />
          </div>
          {notice ? (
            <div className="relative shrink-0 px-1">
              <NoticeBox notice={notice} />
              <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="absolute right-4 top-3 cursor-pointer text-fg/45 hover:text-fg">
                <Icon name="close" className="size-4" />
              </button>
            </div>
          ) : null}
          <div role="tabpanel" className="thin-scroll flex min-h-0 flex-1 flex-col overflow-y-auto p-1">
            {move === "decide" ? <ActionsPanel view={view} operator={operator} busy={busy} run={run} /> : null}
            {move === "agent" ? <AgentPanel incidentId={id} health={health} refresh={() => void refresh().catch(() => undefined)} /> : null}
            {move === "simulate" && health?.sandbox ? <SandboxPanel view={view} busy={busy} run={run} /> : null}
          </div>
        </Tray>
      </div>
    </Workspace>
  );
}
