"use client";

import Link from "next/link";
import type { IncidentSummary } from "../../../src/server/wire";
import { reasonText } from "@/lib/agent-verdict";
import { money } from "@/lib/format";
import { needsYou } from "@/lib/tour-steps";
import { Icon } from "../landing/icons";
import { Chip, Tile, Tray, TrayHead, type ChipTone } from "../kit/widgets";

export const ATTENTION: Record<NonNullable<IncidentSummary["attention"]>["kind"], { label: string; tone: ChipTone }> = {
  ESCALATED: { label: "Handed to you", tone: "warn" },
  NEEDS_ACTION: { label: "Needs a decision", tone: "accent" },
  DRAFT: { label: "Reply to send", tone: "neutral" },
};

/** Step four: everything the agent chose not to decide alone, most urgent first. The bell counts the same list. */
export function Queue({ items }: { items: IncidentSummary[] }) {
  const waiting = needsYou(items);
  return (
    <Tray label="Waiting on you" className="h-full p-3">
      <TrayHead
        n={4}
        className="px-2 pb-3 pt-1"
        title="Waiting on you"
        note="What the agent would not decide alone"
        right={
          <Link href="/queue" className="well readout flex h-7 items-center gap-1.5 rounded-full! px-2.5 text-[11.5px] font-medium text-fg/75 hover:text-fg">
            {String(waiting.length).padStart(2, "0")}
            <Icon name="arrow" className="size-3" />
          </Link>
        }
      />
      {waiting.length === 0 ? (
        <div className="well flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 rounded-[22px]! px-6 text-center">
          <Icon name="check" className="size-6 text-accent" />
          <p className="text-[13px] font-medium">Nothing needs you</p>
          <p className="max-w-[260px] text-[12px] leading-relaxed text-fg/50">Whatever the agent should not settle alone lands here, reasoning attached.</p>
        </div>
      ) : (
        <ul className="thin-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-0.5">
          {waiting.map((item) => (
            <li key={item.id}>
              <Link href={`/incidents/${item.id}`} className="group block">
                <Tile className="rounded-[20px]! px-4 py-3 transition-transform group-hover:-translate-y-px">
                  <span className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="readout truncate text-[12.5px] font-medium">{item.reference}</span>
                      <span className="readout text-[12px] text-fg/55">{money(item.amountMinor, item.currency)}</span>
                    </span>
                    <Chip tone={ATTENTION[item.attention.kind].tone}>{ATTENTION[item.attention.kind].label}</Chip>
                  </span>
                  <span title={item.attention.reason} className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-fg/55">
                    {reasonText(item.attention.reason)}
                  </span>
                  <span className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent">
                    Take it over
                    <Icon name="arrow" className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Tile>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Tray>
  );
}
