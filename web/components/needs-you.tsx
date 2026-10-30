import { actorLabel, reasonText } from "@/lib/agent-verdict";
import { money } from "@/lib/format";
import { needsYou } from "@/lib/tour-steps";
import type { IncidentSummary } from "../../src/server/wire";
import { Frame, Label, LinkButton, PanelHeader, Tag, type Tone } from "./ui";

const KIND: Record<NonNullable<IncidentSummary["attention"]>["kind"], { label: string; tone: Tone }> = {
  ESCALATED: { label: "Handed to you", tone: "ink" },
  NEEDS_ACTION: { label: "Needs a decision", tone: "blue" },
  DRAFT: { label: "Reply to send", tone: "blue-outline" },
};

const clip = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * Every incident that is waiting for a person, most urgent first. Reasons can contain text an agent wrote, so they
 * are only ever rendered as text.
 */
export function NeedsYou({ items }: { items: IncidentSummary[] }) {
  const waiting = needsYou(items);
  if (waiting.length === 0) return null;

  return (
    <section aria-labelledby="needs-you" className="mt-8">
      <Frame tone="ink">
        <PanelHeader title="Needs you" right={<Label className="tnum text-ink">{waiting.length}</Label>} />
        <h3 id="needs-you" className="sr-only">
          Incidents waiting for a person
        </h3>
        <ul className="divide-y divide-rule">
          {waiting.map((item) => {
            const kind = KIND[item.attention.kind];
            const by =
              item.attention.kind === "ESCALATED" && item.lastAgentAction?.tool === "escalate_to_human" && item.lastAgentAction.outcome === "ok"
                ? actorLabel(item.lastAgentAction.actor)
                : null;
            return (
              <li key={item.id} className="grid gap-x-6 gap-y-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span className="font-mono text-[13px] font-medium">{item.reference}</span>
                    <span className="tnum text-[15px] font-semibold">{money(item.amountMinor, item.currency)}</span>
                    <Tag tone={kind.tone}>{kind.label}</Tag>
                    {by ? <span className="text-xs text-muted">Handed over by {by}</span> : null}
                  </div>
                  <p title={item.attention.reason} className="mt-2 max-w-3xl break-words text-sm leading-relaxed text-muted">
                    {clip(reasonText(item.attention.reason))}
                  </p>
                </div>
                <LinkButton href={`/incidents/${item.id}`} variant="secondary" className="h-10 justify-self-start md:justify-self-end">
                  Review
                  <span className="sr-only"> {item.reference}</span>
                </LinkButton>
              </li>
            );
          })}
        </ul>
      </Frame>
    </section>
  );
}
