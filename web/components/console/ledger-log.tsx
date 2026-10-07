import { ago, shortHash } from "@/lib/format";
import { describeEvent } from "@/lib/describe-event";
import type { IncidentView } from "../../../src/server/wire";
import { Frame, Label, PanelHeader, Tag } from "../ui";

/** The append-only history. Every event carries the fingerprint of the one before it, so an edit or a deletion shows. */
export function LedgerLog({ events, chain }: { events: IncidentView["events"]; chain: IncidentView["chain"] }) {
  return (
    <Frame tone="rule">
      <PanelHeader
        title="Ledger"
        right={<Tag tone={chain.ok ? "blue-outline" : "ink"}>{chain.ok ? "History verified" : `Altered at event ${chain.brokenAt}`}</Tag>}
      />
      <p className="border-b border-rule px-5 py-4 text-sm leading-relaxed text-muted">
        Every event is chained to the one before it. Change or remove any of them and the history stops verifying.
      </p>
      <ol className="max-h-[520px] divide-y divide-rule overflow-y-auto">
        {events.toReversed().map((event) => (
          <li key={event.seq} className="grid gap-x-5 gap-y-1 px-5 py-3.5 sm:grid-cols-[56px_150px_1fr_96px]">
            <span className="tnum font-mono text-[12px] text-muted">#{event.seq}</span>
            <Label className="self-center text-ink">{event.type.replaceAll("_", " ")}</Label>
            <p className="text-sm leading-relaxed">{describeEvent(event.type, event.payload)}</p>
            <span className="text-right text-xs text-muted sm:self-center" title={event.ts}>
              {ago(event.ts)}
              <span className="block font-mono text-[11px]">{shortHash(event.hash, 8)}</span>
            </span>
          </li>
        ))}
      </ol>
    </Frame>
  );
}
