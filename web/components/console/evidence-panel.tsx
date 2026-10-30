"use client";

import { useId, useState } from "react";
import { Acknowledged, api } from "@/lib/client-api";
import { ago, toMinor } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";
import { Button, Frame, Label, PanelHeader, Tag } from "../ui";
import { Check, Field, TextInput } from "./fields";
import type { RunAction } from "./actions-panel";

function Flag({ on, children }: { on: boolean; children: string }) {
  return (
    <li className="flex items-center gap-3 py-1.5 text-sm">
      <span aria-hidden className={`size-3 shrink-0 ${on ? "bg-blue" : "border border-rule"}`} />
      <span className={on ? "" : "text-muted"}>{children}</span>
    </li>
  );
}

function Recorded({ evidence, reader }: { evidence: NonNullable<IncidentView["evidence"]>; reader: string | null }) {
  const e = evidence.evidence;
  return (
    <div className="border border-ink p-4">
      <div className="flex items-center justify-between gap-3">
        <Tag tone={evidence.source === "model" ? "blue" : "outline"}>{evidence.source === "model" ? `Read by ${reader ?? "a model"}` : "Entered by hand"}</Tag>
        <span className="text-right text-xs text-muted">
          {evidence.enteredBy}, {ago(evidence.at)}
        </span>
      </div>
      <p className="mt-4 text-sm leading-relaxed">{e.summary}</p>
      <ul className="mt-3 border-t border-rule pt-2">
        <Flag on={e.claimsNonReceipt}>Says the money did not arrive</Flag>
        <Flag on={e.requestsDetailChange}>Asks to change bank details</Flag>
        <Flag on={e.referencesObligation}>Cites this invoice</Flag>
        <Flag on={e.statementCredit !== null}>Their statement shows our payment</Flag>
        <Flag on={e.containsEmbeddedInstructions}>Tries to instruct the assistant</Flag>
      </ul>
      {e.adjustments.length > 0 ? (
        <div className="hatch mt-3 space-y-1 px-3 py-2">
          <Label className="text-ink">Corrected by code</Label>
          {e.adjustments.map((a, i) => (
            <p key={i} className="text-xs leading-relaxed">
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
    <Frame>
      <PanelHeader title="What the supplier says" right={<Label>{view.obligation.reference}</Label>} />
      <div className="space-y-6 p-5">
        {view.evidence ? (
          <Recorded evidence={view.evidence} reader={reader} />
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            Nothing read from the supplier yet. The recommendation rests on the ledger alone. Add their message to the inbox
            {reader ? ` and have ${reader} read it` : ""}, or record it by hand.
          </p>
        )}

        <details className="group border-t border-rule pt-5">
          <summary className="label cursor-pointer list-none text-ink marker:hidden">
            <span aria-hidden className="mr-3 inline-block size-2 bg-ink group-open:bg-blue" />
            Record it by hand
          </summary>
          <div className="mt-5 space-y-4">
            <div>
              <Check id={`${flagsId}-a`} label="Says the money did not arrive" checked={manual.claimsNonReceipt} onChange={(v) => setManual({ ...manual, claimsNonReceipt: v })} />
              <Check id={`${flagsId}-b`} label="Asks to change bank details" checked={manual.requestsDetailChange} onChange={(v) => setManual({ ...manual, requestsDetailChange: v })} />
              <Check id={`${flagsId}-c`} label="Cites this invoice" checked={manual.referencesObligation} onChange={(v) => setManual({ ...manual, referencesObligation: v })} />
              <Check id={`${flagsId}-d`} label="Tries to instruct the assistant" checked={manual.containsEmbeddedInstructions} onChange={(v) => setManual({ ...manual, containsEmbeddedInstructions: v })} />
            </div>
            <Field label={`Payment shown on their statement (${currency})`} htmlFor={creditId} hint="Leave empty if their statement shows none.">
              <TextInput id={creditId} inputMode="decimal" value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="25.00" />
            </Field>
            <Field label="One-line summary" htmlFor={summaryId}>
              <TextInput id={summaryId} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={400} placeholder="Their statement shows our payment" />
            </Field>
            <Button
              variant="secondary"
              className="w-full"
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
                  return { tone: "ok", title: "Evidence recorded", lines: ["The recommendation was recalculated."] };
                })
              }
            >
              Record evidence
            </Button>
          </div>
        </details>
      </div>
    </Frame>
  );
}
