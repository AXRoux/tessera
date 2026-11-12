"use client";

import { actorLabel, reasonText } from "@/lib/agent-verdict";
import { ago } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";
import { Battery, Chip, clock, Kicker, Readout, Tile, useTick } from "../kit/widgets";

type Decision = NonNullable<IncidentView["assessment"]>["decision"];
type Action = Decision["recommended"];

/** The headline names the step the way a colleague would say it across the desk. */
const HEADLINE: Record<Action, string> = {
  NONE: "Nothing to do here",
  WAIT: "Hold steady",
  RECOVER_INTENT: "Settle the open request",
  SEND_STATUS_TO_SUPPLIER: "Tell the supplier where things stand",
  SEND_PROOF_TO_SUPPLIER: "Send the supplier proof",
  REQUEST_CORRECTION: "Ask for corrected details",
  REPLACE: "Replace the payment",
  FUND: "Fund the replacement",
  CLOSE: "Close and certify",
  ESCALATE: "This needs a person",
};

/** The same steps, short enough for a chip. */
export const SHORT: Record<Action, string> = {
  NONE: "Nothing",
  WAIT: "Wait",
  RECOVER_INTENT: "Settle",
  SEND_STATUS_TO_SUPPLIER: "Update",
  SEND_PROOF_TO_SUPPLIER: "Send proof",
  REQUEST_CORRECTION: "Correct details",
  REPLACE: "Replace",
  FUND: "Fund",
  CLOSE: "Certify",
  ESCALATE: "Hand off",
};

const SEVERITY = {
  ROUTINE: { level: 1, label: "Routine" },
  ATTENTION: { level: 2, label: "Worth a look" },
  CRITICAL: { level: 3, label: "Critical" },
} as const;

function SeverityMeter({ severity }: { severity: Decision["severity"] }) {
  const { level, label } = SEVERITY[severity];
  const on = severity === "CRITICAL" ? "bg-bad" : severity === "ATTENTION" ? "bg-warn" : "bg-accent";
  return (
    <span className="well flex h-7 items-center gap-2 rounded-full! pl-2.5 pr-3" role="img" aria-label={`Severity: ${label}`}>
      <span className="flex gap-[3px]">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`h-3 w-[5px] rounded-full ${n <= level ? on : "bg-fg/20"}`} />
        ))}
      </span>
      <span className="text-[11.5px] font-medium text-fg/80">{label}</span>
    </span>
  );
}

/** Who handed the incident over, read from the ledger: the agent's audited escalate call that follows the latest ESCALATED event. */
function escalatedBy(events: IncidentView["events"]): { by: string | null; at: string } | null {
  const escalated = events.findLast((e) => e.type === "ESCALATED");
  if (!escalated) return null;
  const audit = events.find((e) => {
    if (e.seq <= escalated.seq || e.type !== "AGENT_TOOL_CALL") return false;
    const p = e.payload as { tool?: unknown; outcome?: unknown } | null;
    return p?.tool === "escalate_to_human" && p.outcome === "ok";
  });
  const actor = (audit?.payload as { actor?: unknown } | null | undefined)?.actor;
  return { by: typeof actor === "string" ? actorLabel(actor) : null, at: escalated.ts };
}

/** Reasons arrive with the agent's own prefix ("agent:claude: …"); in a sentence the prefix is noise. */
const clean = (reason: string): string => reason.replace(/agent:[\w-]+:\s*/g, "");

/**
 * The window Tessera is waiting out, as a battery that drains and a clock that counts down, live. On stage this is the
 * moment the room watches: when it empties, the sweep looks again and the recommendation may change.
 */
function Window({ recheckAt, since }: { recheckAt: string; since: string | null }) {
  const now = useTick(1000);
  const end = Date.parse(recheckAt);
  const start = since ? Date.parse(since) : null;
  const left = end - now;
  const span = start !== null && end > start ? end - start : null;
  const fraction = span ? left / span : left > 0 ? 1 : 0;
  return (
    <Tile className="flex items-center justify-between gap-4 rounded-[22px]! px-4 py-3.5">
      <div className="min-w-0">
        <Kicker>{left > 0 ? "Tessera looks again in" : "Looking again now"}</Kicker>
        <Readout className="mt-2" size="lg" value={clock(left)} />
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <Battery value={fraction} tone={fraction < 0.2 ? "warn" : "solid"} label={`${Math.round(Math.max(0, fraction) * 100)}% of the window left`}>
          {Math.round(Math.max(0, fraction) * 100)}%
        </Battery>
        <span className="readout text-[11px] text-fg/45">of the window left</span>
      </div>
    </Tile>
  );
}

/**
 * Step one on an incident, and its one inverted tile: what is going on and what Tessera recommends. A handoff leads in
 * the agent's own words; then the window being waited out, the reasons, and what is held back and why. Said once each.
 */
export function DecisionPanel({ view, step = 1 }: { view: IncidentView; step?: number }) {
  const { assessment, assessmentError } = view;
  return (
    <Tile invert as="section" className="flex min-h-0 min-w-0 flex-col rounded-[30px]!">
      <header className="flex shrink-0 items-center justify-between gap-4 px-6 pb-1 pt-5">
        <Kicker>{String(step).padStart(2, "0")} · The situation</Kicker>
        {assessment ? <SeverityMeter severity={assessment.decision.severity} /> : null}
      </header>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {!assessment ? (
          <>
            <h2 className="mt-3 text-[clamp(26px,2.4vw,38px)] font-semibold leading-[1.05] tracking-[-0.045em]">No recommendation, for now</h2>
            <p className="mt-3 max-w-xl text-[13.5px] leading-relaxed text-fg/65">{assessmentError ?? "The assessment could not be reached."} The history alongside remains the record of truth.</p>
          </>
        ) : (
          <Recommendation view={view} decision={assessment.decision} />
        )}
      </div>
    </Tile>
  );
}

function Recommendation({ view, decision: d }: { view: IncidentView; decision: Decision }) {
  const escalated = view.obligation.status === "ESCALATED";
  const closed = view.obligation.status === "CLOSED";
  const handoff = escalated ? escalatedBy(view.events) : null;
  const latest = view.attempts.at(-1) ?? null;
  // A handed-over incident already says why in the handoff; the playbook's "already with a person" line would repeat it.
  const reasons = [...new Set(d.reasons.map(clean))].filter((reason) => !(escalated && /^already with a person/i.test(reason)));
  const blocked: { action: Action; reasons: string[] }[] = [];
  for (const b of d.blocked) {
    const group = blocked.find((g) => g.action === b.action);
    if (group) group.reasons.push(clean(b.reason));
    else blocked.push({ action: b.action, reasons: [clean(b.reason)] });
  }

  return (
    <>
      <p className="mt-3 text-[12.5px] text-fg/55">Tessera recommends</p>
      <h2 className="mt-1 text-[clamp(28px,2.6vw,42px)] font-semibold leading-[1.02] tracking-[-0.05em]">{closed ? "Certified. Nothing left to do." : HEADLINE[d.recommended]}</h2>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[12px] text-fg/55">Safe right now</span>
        {d.allowed.length === 0 ? <span className="text-[12px] text-fg/50">nothing</span> : null}
        {d.allowed.map((action) => (
          <Chip key={action} tone={action === d.recommended ? "accent" : "neutral"}>
            {SHORT[action]}
          </Chip>
        ))}
      </div>

      <div className="mt-5 space-y-2.5">
        {d.recheckAt ? <Window recheckAt={d.recheckAt} since={latest?.createdAt ?? null} /> : null}

        {escalated ? (
          <Tile className="rounded-[22px]! px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span aria-hidden className="size-2 rounded-full bg-warn" />
                Handed to you{handoff?.by ? ` by ${handoff.by}` : ""}
              </span>
              {handoff ? (
                <span suppressHydrationWarning className="readout text-[11px] text-fg/45">
                  {ago(handoff.at)}
                </span>
              ) : null}
            </div>
            <blockquote className="mt-2 text-[13.5px] leading-relaxed text-fg/90">&ldquo;{reasonText(view.obligation.escalationReason ?? "No reason was recorded.")}&rdquo;</blockquote>
            <p className="mt-2.5 text-[12px] leading-relaxed text-fg/50">Nothing moves until you decide. Take it back in writing under Your move, or leave it where it is.</p>
          </Tile>
        ) : null}
      </div>

      {reasons.length > 0 ? (
        <div className="mt-5">
          <Kicker>Why</Kicker>
          <ol className="mt-2.5 space-y-2.5">
            {reasons.map((reason, i) => (
              <li key={i} className="flex gap-3">
                <span className="well readout mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full! text-[10.5px] text-fg/70">{i + 1}</span>
                <p className="text-[13.5px] leading-relaxed text-fg/85">{reason}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {blocked.length > 0 ? (
        <div className="mt-5">
          <Kicker>Held back, and why</Kicker>
          <ul className="mt-2.5 space-y-2">
            {blocked.map((group) => (
              <li key={group.action} className="well rounded-[18px]! px-4 py-2.5">
                <span className="flex items-center gap-2 text-[12.5px] font-semibold">
                  <span aria-hidden className="size-1.5 rounded-full bg-bad" />
                  {SHORT[group.action]}
                </span>
                <ul className="mt-1 space-y-0.5">
                  {[...new Set(group.reasons)].map((reason) => (
                    <li key={reason} className="text-[12.5px] leading-relaxed text-fg/60">
                      {reason}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
