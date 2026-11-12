"use client";

import { useId, useState } from "react";
import { Acknowledged, api } from "@/lib/client-api";
import { ago, toMinor } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";

import { Check, Field, Fold, TextInput } from "./fields";
import type { RunAction } from "./actions-panel";
import { Btn } from "../kit/metal";
import { Chip } from "../kit/widgets";

function Flag({ on, children }: { on: boolean; children: string }) {
  return (
    <li className="flex items-center gap-2.5 py-1 text-[12.5px]">
      <span aria-hidden className={`flex size-4 shrink-0 items-center justify-center rounded-full ${on ? "bg-accent text-white" : "well"}`}>
        {on ? (
          <svg viewBox="0 0 12 12" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 6.5 5 9l4.5-5.5" />
          </svg>
        ) : null}
      </span>
      <span className={on ? "text-fg" : "text-fg/45"}>{children}</span>
    </li>
  );
}

function Recorded({ evidence, reader }: { evidence: NonNullable<IncidentView["evidence"]>; reader: string | null }) {
  const e = evidence.evidence;
  return (
    <div className="tile rounded-[20px]! p-4">
      <div className="flex items-center justify-between gap-3">
        <Chip tone={evidence.source === "model" ? "accent" : "neutral"}>{evidence.source === "model" ? `Read by ${reader ?? "a model"}` : "Entered by hand"}</Chip>
        <span suppressHydrationWarning className="text-right text-[11.5px] text-fg/45">
          {evidence.enteredBy}, {ago(evidence.at)}
        </span>
      </div>
      <p className="mt-3 text-[13.5px] leading-relaxed">{e.summary}</p>
      <ul className="mt-3 grid grid-cols-1 border-t border-fg/[0.06] pt-2 xl:grid-cols-2">
        <Flag on={e.claimsNonReceipt}>Says the money never arrived</Flag>
        <Flag on={e.requestsDetailChange}>Asks to change bank details</Flag>
        <Flag on={e.referencesObligation}>Cites this invoice</Flag>
        <Flag on={e.statementCredit !== null}>Their statement shows our payment</Flag>
        <Flag on={e.containsEmbeddedInstructions}>Tries to instruct the assistant</Flag>
      </ul>
      {e.adjustments.length > 0 ? (
        <div className="well mt-3 space-y-1 rounded-[14px]! px-3 py-2">
          <p className="text-[11.5px] font-medium text-fg">Corrected by code</p>
          {e.adjustments.map((a, i) => (
            <p key={i} className="text-[12px] leading-relaxed text-fg/70">
              {a}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface Props {
  view: IncidentView;
  /** Who reads supplier messages on this server, or null when nothing does. */
  reader: string | null;
  busy: string | null;
  run: RunAction;
}

/** What the supplier is claiming, as the reader understood it and as code then corrected it; or a form to record it by hand. */
export function EvidencePanel({ view, reader, busy, run }: Props) {
  const flagsId = useId();
  const summaryId = useId();
  const creditId = useId();
  const [manual, setManual] = useState({ claimsNonReceipt: false, requestsDetailChange: false, referencesObligation: true, containsEmbeddedInstructions: false });
  const [credit, setCredit] = useState("");
  const [summary, setSummary] = useState("");

  const id = view.obligation.id;
  const currency = view.obligation.currency;

  return (
    <div className="space-y-3">
      <span className="kicker block">What the supplier says</span>
      {view.evidence ? (
        <Recorded evidence={view.evidence} reader={reader} />
      ) : (
        <p className="well rounded-[18px]! px-4 py-4 text-[12.5px] leading-relaxed text-fg/55">
          Nothing has been read from the supplier, so the recommendation rests on the ledger alone. Add their message to the inbox{reader ? ` and let ${reader} read it` : ""}, or record
          what they said by hand.
        </p>
      )}

      <Fold title="Record it by hand" sub="When the conversation happened on the phone, or anywhere else">
        <div className="space-y-3">
          <div>
            <Check id={`${flagsId}-a`} label="Says the money never arrived" checked={manual.claimsNonReceipt} onChange={(v) => setManual({ ...manual, claimsNonReceipt: v })} />
            <Check id={`${flagsId}-b`} label="Asks to change bank details" checked={manual.requestsDetailChange} onChange={(v) => setManual({ ...manual, requestsDetailChange: v })} />
            <Check id={`${flagsId}-c`} label="Cites this invoice" checked={manual.referencesObligation} onChange={(v) => setManual({ ...manual, referencesObligation: v })} />
            <Check id={`${flagsId}-d`} label="Tries to instruct the assistant" checked={manual.containsEmbeddedInstructions} onChange={(v) => setManual({ ...manual, containsEmbeddedInstructions: v })} />
          </div>
          <Field label={`Payment shown on their statement (${currency})`} htmlFor={creditId} hint="Leave it empty if their statement shows nothing from us.">
            <TextInput id={creditId} inputMode="decimal" value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="25.00" />
          </Field>
          <Field label="In one line" htmlFor={summaryId}>
            <TextInput id={summaryId} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={400} placeholder="Their statement shows our payment landed on the 4th" />
          </Field>
          <Btn
            tone="secondary"
            block
            disabled={summary.trim().length === 0}
            busy={busy === "manual"}
            onClick={() =>
              run("manual", async () => {
                const parsed = Number(credit);
                const creditMinor = credit.trim() === "" || !Number.isFinite(parsed) || parsed <= 0 ? null : toMinor(parsed, currency);
                await api(`obligations/${id}/evidence`, Acknowledged, {
                  method: "POST",
                  body: { ...manual, statementCreditMinor: creditMinor, summary: summary.trim() },
                });
                setSummary("");
                setCredit("");
                return { tone: "ok", title: "Evidence recorded", lines: ["The recommendation has been weighed again with it."] };
              })
            }
          >
            Record the evidence
          </Btn>
        </div>
      </Fold>
    </div>
  );
}
