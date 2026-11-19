"use client";

import { InvestigationSchema, type InvestigationRecord, type IncidentView } from "../../../src/server/wire";
import { ago } from "@/lib/format";
import { Icon } from "../landing/icons";
import { Chip } from "../kit/widgets";

type Found = InvestigationRecord & { at: string };

const VERDICT_TONE = { impersonation: "bad", suspicious: "warn", clear: "accent" } as const;

/** The latest investigation in an incident's history, if one ran. */
export function latestInvestigation(view: Pick<IncidentView, "events">): Found | null {
  for (const e of view.events.toReversed()) {
    if (e.type !== "INVESTIGATED") continue;
    const p = InvestigationSchema.safeParse(e.payload);
    if (p.success) return { ...p.data, at: e.ts };
  }
  return null;
}

/** Who ran it, as a person reads it: "the agent", or the person's name. */
const byWhom = (by: string): string => (by.startsWith("agent:") ? "the agent" : by.split("@")[0]!);

/**
 * What an investigation of a supplier message found: the verdict, every check against the vendor record and the
 * ledger (red flags first), and what a person should do. `compact` keeps only the red flags and the first steps.
 */
export function InvestigationReport({ found, compact = false }: { found: Found; compact?: boolean }) {
  const flags = found.checks.filter((c) => !c.ok);
  const fine = found.checks.filter((c) => c.ok);
  const shown = compact ? flags : [...flags, ...fine];
  const steps = compact ? found.nextSteps.slice(0, 2) : found.nextSteps;
  return (
    <div className={compact ? "space-y-2.5" : "tile space-y-3.5 rounded-[20px]! p-4"}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <Chip tone={VERDICT_TONE[found.verdict]}>
          {found.label}
          {flags.length > 0 ? ` · ${flags.length} red ${flags.length === 1 ? "flag" : "flags"}` : ""}
        </Chip>
        <span suppressHydrationWarning className="text-[12px] text-fg/45">
          by {byWhom(found.by)}, {ago(found.at)}
        </span>
      </div>
      <ul className="space-y-2">
        {shown.map((check) => (
          <li key={check.id} className="flex gap-2.5">
            <span className={`mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full ${check.ok ? "bg-ok/15 text-ok" : "bg-bad/15 text-bad"}`}>
              <Icon name={check.ok ? "check" : "close"} className="size-3" />
            </span>
            <div className="min-w-0">
              <p className={`text-[13px] font-semibold leading-snug ${check.ok ? "text-fg/80" : "text-fg"}`}>{check.label}</p>
              {compact ? null : <p className="mt-0.5 text-[12.5px] leading-snug text-fg/60">{check.detail}</p>}
            </div>
          </li>
        ))}
      </ul>
      {found.verdict !== "clear" ? (
        <div className="rounded-[14px] bg-warn/[0.09] px-3 py-2.5 ring-1 ring-inset ring-warn/30">
          <p className="text-[12px] font-semibold text-warn">What to do</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[12.5px] leading-snug text-fg/75">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {compact ? null : (
        <p className="text-[12px] leading-snug text-fg/45">
          Checked in code against the vendor record and the ledger, for the message from {found.from}. The agent sees the verdict, never the message.
        </p>
      )}
    </div>
  );
}
