import { ago, shortHash } from "@/lib/format";
import { bandOf, BAND_STYLE } from "@/lib/activity";
import { describeEvent, eventTitle } from "@/lib/describe-event";
import type { IncidentView } from "../../../src/server/wire";
import { Icon } from "../landing/icons";
import { Tile } from "../kit/widgets";

/** The append-only history, newest first. Every entry carries the fingerprint of the one before it, so an edit shows. */
export function LedgerLog({ events, chain }: { events: IncidentView["events"]; chain: IncidentView["chain"] }) {
  return (
    <div className="space-y-3">
      <p className={`well flex items-start gap-2.5 rounded-[16px]! px-4 py-3 text-[12.5px] leading-relaxed ${chain.ok ? "text-fg/70" : "text-bad"}`}>
        <Icon name="shield" className={`mt-px size-4 shrink-0 ${chain.ok ? "text-accent" : "text-bad"}`} />
        {chain.ok
          ? "Each entry is sealed to the one before it. Alter or remove a single line and this chain breaks, visibly."
          : `The chain breaks at entry ${chain.brokenAt}. Something here was changed after it was written.`}
      </p>
      <Tile className="overflow-hidden rounded-[22px]!">
        <ol>
          {events.toReversed().map((event) => (
            <li key={event.seq} className="grid grid-cols-[38px_minmax(0,1fr)_auto] gap-x-3 border-b border-fg/[0.06] px-4 py-2.5 last:border-b-0">
              <span className="readout pt-0.5 text-[10.5px] text-fg/35">#{event.seq}</span>
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[12.5px] font-semibold tracking-[-0.01em]">
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: BAND_STYLE[bandOf(event.type)].color }} />
                  {eventTitle(event.type)}
                </p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg/60">{describeEvent(event.type, event.payload)}</p>
              </div>
              <span className="readout text-right text-[10.5px] text-fg/40" title={event.ts}>
                <span suppressHydrationWarning>{ago(event.ts)}</span>
                <span className="block text-fg/25">{shortHash(event.hash, 8)}</span>
              </span>
            </li>
          ))}
        </ol>
      </Tile>
    </div>
  );
}
