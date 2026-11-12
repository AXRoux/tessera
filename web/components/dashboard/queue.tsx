"use client";

import Link from "next/link";
import type { IncidentSummary } from "../../../src/server/wire";
import { reasonText } from "@/lib/agent-verdict";
import { money } from "@/lib/format";
import { needsYou } from "@/lib/tour-steps";
import { Label, Tag, type Tone } from "../ui";

const KIND: Record<NonNullable<IncidentSummary["attention"]>["kind"], { label: string; tone: Tone }> = {
  ESCALATED: { label: "Handed to you", tone: "ink" },
  NEEDS_ACTION: { label: "Needs a decision", tone: "blue" },
  DRAFT: { label: "Reply to send", tone: "blue-outline" },
};

const clip = (text: string, max = 150): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Everything waiting on a person, most urgent first. The rail counts the same list, so the two can never disagree. */
export function Queue({ items }: { items: IncidentSummary[] }) {
  const waiting = needsYou(items);
  return (
    <section id="needs-you" data-shell-section className="panel flex min-w-0 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-white/[0.075] px-5 py-4">
        <div>
          <h2 className="text-[15px] font-medium tracking-[-0.01em]">Needs you</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">What the agent could not settle safely</p>
        </div>
        <Label className="tnum rounded-full bg-white/[0.07] px-2.5 py-1 text-[12px] text-white">{waiting.length}</Label>
      </header>

      {waiting.length === 0 ? (
        <p className="px-5 py-5 text-[13px] leading-relaxed text-muted">
          Nothing is waiting for a person. Anything the agent cannot settle safely lands here with the reason it stopped.
        </p>
      ) : (
        <ul className="divide-y divide-white/[0.07]">
          {waiting.map((item) => (
            <li key={item.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <span className="flex items-center gap-3">
                  <Link href={`/incidents/${item.id}`} className="font-mono text-[13px] hover:text-sky">
                    {item.reference}
                  </Link>
                  <span className="tnum text-[14px] font-medium">{money(item.amountMinor, item.currency)}</span>
                </span>
                <Tag tone={KIND[item.attention.kind].tone}>{KIND[item.attention.kind].label}</Tag>
              </div>
              <p title={item.attention.reason} className="mt-2 text-[12.5px] leading-snug text-muted">
                {clip(reasonText(item.attention.reason))}
              </p>
              <Link
                href={`/incidents/${item.id}`}
                className="hairline mt-3 inline-flex h-9 items-center rounded-full border px-4 text-[12.5px] text-soft transition-colors hover:bg-white/[0.06]"
              >
                Take it over
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
