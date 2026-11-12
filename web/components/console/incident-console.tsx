"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiProblem } from "@/lib/client-api";
import { money } from "@/lib/format";
import { STATUS } from "@/lib/status";
import { IncidentViewSchema, type Health, type IncidentView } from "../../../src/server/wire";
import { AgentPanel } from "../agent/agent-panel";
import { Tag } from "../ui";
import { ActionsPanel, type RunAction } from "./actions-panel";
import { AttemptsRail } from "./attempts-rail";
import { CertificatePanel } from "./certificate-panel";
import { DraftPanel } from "./draft-panel";
import { DecisionPanel } from "./decision-panel";
import { EvidencePanel } from "./evidence-panel";
import { NoticeBox, type Notice } from "./fields";
import { FundingPanel } from "./funding-panel";
import { InboxPanel } from "./inbox-panel";
import { HandoffBanner } from "./handoff-banner";
import { LedgerLog } from "./ledger-log";
import { SandboxPanel } from "./sandbox-panel";
import { markTakeoverOpened } from "../tour";
import { viewNeedsPerson } from "@/lib/tour-steps";

const POLL_MS = 3000;

function toNotice(error: unknown): Notice {
  if (error instanceof ApiProblem) {
    const lines = error.problem.reasons ?? error.problem.blockers ?? [error.problem.message];
    return { tone: "refused", title: error.status === 409 ? "Refused" : "Request failed", lines };
  }
  return { tone: "refused", title: "Request failed", lines: [error instanceof Error ? error.message : "Unexpected error"] };
}

export function IncidentConsole({ initial, health }: { initial: IncidentView; health: Health | null }) {
  const id = initial.obligation.id;
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const busyRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setView(await api(`obligations/${id}`, IncidentViewSchema));
  }, [id]);

  // Poll only while idle: a refresh landing mid-action would repaint a half-finished state.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && busyRef.current === null) void refresh().catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // The walkthrough's "take over" step is done once the operator has looked at an incident that was waiting for them.
  const needsPerson = viewNeedsPerson(view);
  useEffect(() => {
    if (needsPerson) markTakeoverOpened();
  }, [needsPerson]);

  const run: RunAction = useCallback(
    async (key, work) => {
      busyRef.current = key;
      setBusy(key);
      setNotice(null);
      try {
        const result = await work();
        if (result) setNotice(result);
      } catch (error) {
        setNotice(toNotice(error));
      } finally {
        await refresh().catch(() => undefined);
        busyRef.current = null;
        setBusy(null);
      }
    },
    [refresh],
  );

  const o = view.obligation;
  const status = STATUS[o.status];
  const feesKept = view.attempts.reduce((sum, a) => sum + (a.feeMinor ?? 0), 0);
  const delivered = view.attempts.filter((a) => a.state === "PAID").reduce((sum, a) => sum + a.amountMinor, 0);
  // Who reads supplier messages, as the server names it: the configured model, or offline the keyword reader (not a model).
  const reader = health?.reader ?? null;

  return (
    <>
      <div className="mx-auto max-w-[1200px] px-6 pt-8 sm:px-10">
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
          <div className="min-w-0">
            <Link href="/dashboard#incidents" className="inline-flex items-center gap-2 text-[13px] text-muted transition-colors hover:text-white">
              <span aria-hidden>&larr;</span> All incidents
            </Link>
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <h1 className="heading text-[clamp(26px,3.4vw,40px)] leading-none">{o.reference}</h1>
              <Tag tone={status.tone} pulse={status.pulse}>
                {status.label}
              </Tag>
              <Tag tone={view.chain.ok ? "blue-outline" : "ink"}>{view.chain.ok ? "History verified" : "History altered"}</Tag>
            </div>
            <p className="tnum mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
              <span>{money(o.amountMinor, o.currency)} owed</span>
              <span>
                {view.attempts.length} attempt{view.attempts.length === 1 ? "" : "s"} &middot; {money(feesKept, o.currency)} fees
              </span>
              <span>{money(delivered, o.currency)} delivered</span>
              <span>
                {o.method} &middot; {o.currency}
              </span>
            </p>
          </div>
        </div>
      </div>

      <HandoffBanner view={view} />

      <div className="mx-auto max-w-[1200px] px-6 pt-8 sm:px-10">
        {notice ? (
          <div className="mb-6">
            <NoticeBox notice={notice} />
          </div>
        ) : null}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
          <div className="min-w-0 space-y-6">
            <DecisionPanel view={view} />
            <AttemptsRail attempts={view.attempts} />
            <DraftPanel view={view} busy={busy} run={run} />
            <LedgerLog events={view.events} chain={view.chain} />
          </div>
          <aside className="min-w-0 space-y-6 lg:sticky lg:top-24 lg:self-start">
            <AgentPanel incidentId={id} health={health} refresh={() => void refresh().catch(() => undefined)} />
            <ActionsPanel view={view} operator={health?.operator ?? "operator"} busy={busy} run={run} />
            <FundingPanel view={view} operator={health?.operator ?? "operator"} busy={busy} run={run} />
            <InboxPanel view={view} reader={reader} busy={busy} run={run} />
            <EvidencePanel view={view} reader={reader} busy={busy} run={run} />
            {health?.sandbox ? <SandboxPanel view={view} busy={busy} run={run} /> : null}
            <CertificatePanel view={view} />
          </aside>
        </div>
      </div>
    </>
  );
}
