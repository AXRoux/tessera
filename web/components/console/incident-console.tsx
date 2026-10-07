"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiProblem } from "@/lib/client-api";
import { money } from "@/lib/format";
import { STATUS } from "@/lib/status";
import { IncidentViewSchema, type Health, type IncidentView } from "../../../src/server/wire";
import { Label, Stat, StatStrip, Tag } from "../ui";
import { ActionsPanel, type RunAction } from "./actions-panel";
import { AttemptsRail } from "./attempts-rail";
import { CertificatePanel } from "./certificate-panel";
import { DecisionPanel } from "./decision-panel";
import { EvidencePanel } from "./evidence-panel";
import { NoticeBox, type Notice } from "./fields";
import { LedgerLog } from "./ledger-log";
import { SandboxPanel } from "./sandbox-panel";

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

  return (
    <>
      <div className="mx-auto max-w-[1440px] px-6 pb-10 pt-8 sm:px-10">
        <Link href="/" className="label hover:text-blue">
          &larr; Incidents
        </Link>
        <div className="mt-6 flex flex-wrap items-end justify-between gap-6">
          <div>
            <Label>Invoice / {o.method} / {o.currency}</Label>
            <h1 className="mt-4 font-display text-[clamp(28px,4vw,52px)] leading-none tracking-wide">{o.reference}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Tag tone={status.tone} pulse={status.pulse}>
              {status.label}
            </Tag>
            <Tag tone={view.chain.ok ? "blue-outline" : "ink"}>{view.chain.ok ? "History verified" : "History altered"}</Tag>
          </div>
        </div>
      </div>

      <StatStrip>
        <Stat value={money(o.amountMinor, o.currency)} label="Owed to the supplier" />
        <Stat value={view.attempts.length} label={view.attempts.length === 1 ? "Payment attempt" : "Payment attempts"} />
        <Stat value={money(feesKept, o.currency)} label="Fees spent so far" />
        <Stat value={money(delivered, o.currency)} label="Delivered to the supplier" />
      </StatStrip>

      <div className="mx-auto max-w-[1440px] px-6 pt-10 sm:px-10">
        {notice ? (
          <div className="mb-8">
            <NoticeBox notice={notice} />
          </div>
        ) : null}
        <div className="grid gap-8 lg:grid-cols-12">
          <div className="space-y-8 lg:col-span-8">
            <DecisionPanel view={view} />
            <AttemptsRail attempts={view.attempts} />
            <LedgerLog events={view.events} chain={view.chain} />
          </div>
          <aside className="space-y-8 lg:col-span-4">
            <ActionsPanel view={view} operator={health?.operator ?? "operator"} busy={busy} run={run} />
            <EvidencePanel view={view} modelAvailable={health?.model ?? false} busy={busy} run={run} />
            {health?.sandbox ? <SandboxPanel view={view} busy={busy} run={run} /> : null}
            <CertificatePanel view={view} />
          </aside>
        </div>
      </div>
    </>
  );
}
