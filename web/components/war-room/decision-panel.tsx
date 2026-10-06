import { until } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";
import { Frame, Index, Label, PanelHeader, Tag } from "../ui";

type Decision = NonNullable<IncidentView["assessment"]>["decision"];
type Action = Decision["recommended"];

/** The headline names the step the way an operator would say it aloud. */
const HEADLINE: Record<Action, string> = {
  NONE: "Nothing to do",
  WAIT: "Wait",
  RECOVER_INTENT: "Resolve the open request",
  SEND_STATUS_TO_SUPPLIER: "Update the supplier",
  SEND_PROOF_TO_SUPPLIER: "Send proof of payment",
  REQUEST_CORRECTION: "Ask for corrected details",
  REPLACE: "Replace the payment",
  CLOSE: "Close the incident",
  ESCALATE: "Hand to a person",
};

/** The same steps, short enough for a tag. */
const SHORT: Record<Action, string> = {
  NONE: "None",
  WAIT: "Wait",
  RECOVER_INTENT: "Resolve",
  SEND_STATUS_TO_SUPPLIER: "Update",
  SEND_PROOF_TO_SUPPLIER: "Send proof",
  REQUEST_CORRECTION: "Correct details",
  REPLACE: "Replace",
  CLOSE: "Close",
  ESCALATE: "Hand off",
};

const SEVERITY = {
  ROUTINE: { level: 1, label: "Routine" },
  ATTENTION: { level: 2, label: "Needs attention" },
  CRITICAL: { level: 3, label: "Critical" },
} as const;

function SeverityMeter({ severity }: { severity: Decision["severity"] }) {
  const { level, label } = SEVERITY[severity];
  return (
    <span className="flex items-center gap-3" role="img" aria-label={`Severity: ${label}`}>
      <span className="flex gap-1.5">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`h-4 w-2.5 ${n <= level ? (severity === "CRITICAL" ? "bg-ink" : "bg-blue") : "border border-rule"}`} />
        ))}
      </span>
      <Label className="text-ink">{label}</Label>
    </span>
  );
}

export function DecisionPanel({ view }: { view: IncidentView }) {
  const { assessment, assessmentError } = view;

  if (!assessment) {
    return (
      <Frame>
        <PanelHeader title="Recommended next step" />
        <div className="hatch px-6 py-12">
          <p className="font-display text-2xl tracking-wide">No recommendation right now</p>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted">
            {assessmentError ?? "The assessment is unavailable."} The ledger below is still the record of truth.
          </p>
        </div>
      </Frame>
    );
  }

  const d = assessment.decision;
  const closed = view.obligation.status === "CLOSED";
  return (
    <Frame tone={d.severity === "CRITICAL" ? "ink" : "blue"}>
      <PanelHeader title="Recommended next step" right={<SeverityMeter severity={d.severity} />} />
      <div className="px-6 pb-8 pt-8 sm:px-8">
        <h2 className="font-display text-[clamp(30px,4.4vw,54px)] leading-[1.05] tracking-wide">
          {closed ? "Certified" : HEADLINE[d.recommended]}
        </h2>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Label className="mr-2">Safe to do now</Label>
          {d.allowed.map((action) => (
            <Tag key={action} tone={action === d.recommended ? "blue" : "outline"}>
              {SHORT[action]}
            </Tag>
          ))}
        </div>

        {d.recheckAt ? (
          <p className="mt-6 flex items-center gap-3 text-sm">
            <span aria-hidden className="beat size-2 bg-blue" />
            Check again in <strong className="tnum font-semibold">{until(d.recheckAt)}</strong>
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
            <Label>Not allowed, and why</Label>
            <ul className="mt-4 divide-y divide-rule border-y border-rule">
              {d.blocked.map((b, i) => (
                <li key={i} className="hatch grid gap-1 px-4 py-3 sm:grid-cols-[220px_1fr] sm:gap-6">
                  <span className="font-mono text-[12px] font-medium uppercase tracking-wider">{SHORT[b.action]}</span>
                  <span className="text-sm leading-relaxed text-muted">{b.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Frame>
  );
}
