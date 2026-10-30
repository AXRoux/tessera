import { actorLabel, reasonText } from "@/lib/agent-verdict";
import { ago } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";
import { Label } from "../ui";

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

/** Top of the incident page while the incident is handed to a person. The decision itself lives in the actions panel. */
export function HandoffBanner({ view }: { view: IncidentView }) {
  const { obligation } = view;
  if (obligation.status !== "ESCALATED") return null;
  const source = escalatedBy(view.events);

  return (
    <div className="mx-auto max-w-[1440px] px-6 pb-10 sm:px-10">
      <section aria-labelledby="handoff" className="border-l-4 border-ink bg-wash px-5 py-5">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h2 id="handoff" className="font-display text-xl tracking-wide">
            Handed to you
          </h2>
          {source ? (
            <Label>
              {source.by ? `By ${source.by} \u00b7 ` : ""}
              <span suppressHydrationWarning>{ago(source.at)}</span>
            </Label>
          ) : null}
        </div>
        <p className="mt-3 max-w-3xl whitespace-pre-line break-words text-sm leading-relaxed">{reasonText(obligation.escalationReason ?? "No reason was recorded.")}</p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">
          Read the reasons, then either resolve the escalation with a written note (&ldquo;Take it back from escalation&rdquo;) or leave it. Nothing moves money until you decide.
        </p>
      </section>
    </div>
  );
}
