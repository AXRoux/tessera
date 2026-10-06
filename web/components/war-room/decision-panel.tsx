import { until } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";
import { Frame, Index, Label, PanelHeader, Tag } from "../ui";

type Decision = NonNullable<IncidentView["assessment"]>["decision"];
type Action = Decision["recommended"];

const HEADLINE: Record<Action, string> = {
  NONE: "Nothing to do",
  WAIT: "Wait",
  RECOVER_INTENT: "Recover",
  SEND_STATUS_TO_SUPPLIER: "Send status",
  SEND_PROOF_TO_SUPPLIER: "Send proof",
  REQUEST_CORRECTION: "Request correction",
  REPLACE: "Replace",
  CLOSE: "Close",
  ESCALATE: "Escalate",
};

const SEVERITY_LEVEL = { ROUTINE: 1, ATTENTION: 2, CRITICAL: 3 } as const;

function SeverityMeter({ severity }: { severity: Decision["severity"] }) {
  const level = SEVERITY_LEVEL[severity];
  return (
    <span className="flex items-center gap-3" role="img" aria-label={`Severity ${severity.toLowerCase()}`}>
      <span className="flex gap-1.5">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`h-4 w-2.5 ${n <= level ? (severity === "CRITICAL" ? "bg-ink" : "bg-blue") : "border border-rule"}`} />
        ))}
      </span>
      <Label className="text-ink">{severity}</Label>
    </span>
  );
}

export function DecisionPanel({ view }: { view: IncidentView }) {
  const { assessment, assessmentError } = view;

  if (!assessment) {
    return (
      <Frame>
        <PanelHeader title="Commander recommends" />
        <div className="hatch px-6 py-12">
          <p className="font-display text-2xl tracking-wide">Cannot assess right now</p>
          <p className="mt-4 max-w-xl text-sm text-muted">{assessmentError ?? "No assessment is available."} The ledger below is still authoritative.</p>
        </div>
      </Frame>
    );
  }

  const d = assessment.decision;
  return (
    <Frame tone={d.severity === "CRITICAL" ? "ink" : "blue"}>
      <PanelHeader title="Commander recommends" right={<SeverityMeter severity={d.severity} />} />
      <div className="px-6 pb-8 pt-8 sm:px-8">
        <h2 className="font-display text-[clamp(34px,5vw,60px)] leading-none tracking-wide">
          {view.obligation.status === "CLOSED" ? "Certified" : HEADLINE[d.recommended]}
        </h2>

        <div className="mt-6 flex flex-wrap gap-2">
          {d.allowed.map((action) => (
            <Tag key={action} tone={action === d.recommended ? "blue" : "outline"}>
              {HEADLINE[action]}
            </Tag>
          ))}
        </div>

        {d.recheckAt ? (
          <p className="mt-6 flex items-center gap-3 text-sm">
            <span aria-hidden className="beat size-2 bg-blue" />
            Look again in <strong className="tnum font-semibold">{until(d.recheckAt)}</strong>
          </p>
        ) : null}

        <ol className="mt-8 space-y-4">
          {d.reasons.map((reason, i) => (
            <li key={i} className="flex gap-4">
              <Index n={i + 1} />
              <p className="pt-1 leading-relaxed">{reason}</p>
            </li>
          ))}
        </ol>

        {d.blocked.length > 0 ? (
          <div className="mt-10">
            <Label>Refused by code</Label>
            <ul className="mt-4 divide-y divide-rule border-y border-rule">
              {d.blocked.map((b, i) => (
                <li key={i} className="hatch grid gap-1 px-4 py-3 sm:grid-cols-[200px_1fr] sm:gap-6">
                  <span className="font-mono text-[12px] font-medium uppercase tracking-wider">{HEADLINE[b.action]}</span>
                  <span className="text-sm text-muted">{b.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Frame>
  );
}
