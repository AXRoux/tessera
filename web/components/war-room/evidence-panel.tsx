"use client";

import { useId, useState } from "react";
import { Acknowledged, api } from "@/lib/client-api";
import { ago, toMinor } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";
import { Button, Frame, Label, PanelHeader, Tag } from "../ui";
import { Check, Field, TextArea, TextInput } from "./fields";
import type { RunAction } from "./actions-panel";

function Flag({ on, children }: { on: boolean; children: string }) {
  return (
    <li className="flex items-center gap-3 py-1.5 text-sm">
      <span aria-hidden className={`size-3 ${on ? "bg-blue" : "border border-rule"}`} />
      <span className={on ? "" : "text-muted"}>{children}</span>
    </li>
  );
}

function Recorded({ evidence }: { evidence: NonNullable<IncidentView["evidence"]> }) {
  const e = evidence.evidence;
  return (
    <div className="border border-ink p-4">
      <div className="flex items-center justify-between gap-3">
        <Tag tone={evidence.source === "model" ? "blue" : "outline"}>{evidence.source === "model" ? "Read by Claude" : "Entered by hand"}</Tag>
        <span className="text-xs text-muted">
          {evidence.enteredBy}, {ago(evidence.at)}
        </span>
      </div>
      <p className="mt-4 text-sm leading-relaxed">{e.summary}</p>
      <ul className="mt-3 border-t border-rule pt-2">
        <Flag on={e.claimsNonReceipt}>Supplier says nothing arrived</Flag>
        <Flag on={e.requestsDetailChange}>Asks to change bank details</Flag>
        <Flag on={e.referencesObligation}>Cites this reference</Flag>
        <Flag on={e.statementCredit !== null}>Their statement shows our credit</Flag>
        <Flag on={e.containsEmbeddedInstructions}>Tries to instruct the assistant</Flag>
      </ul>
      {e.adjustments.length > 0 ? (
        <div className="hatch mt-3 space-y-1 px-3 py-2">
          <Label className="text-ink">Code overrode the model</Label>
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
  modelAvailable: boolean;
  busy: string | null;
  run: RunAction;
}

export function EvidencePanel({ view, modelAvailable, busy, run }: Props) {
  const emailId = useId();
  const statementId = useId();
  const summaryId = useId();
  const creditId = useId();
  const [email, setEmail] = useState("");
  const [statement, setStatement] = useState("");
  const [manual, setManual] = useState({ claimsNonReceipt: false, requestsDetailChange: false, referencesObligation: true, containsEmbeddedInstructions: false });
  const [credit, setCredit] = useState("");
  const [summary, setSummary] = useState("");

  const id = view.obligation.id;
  const currency = view.obligation.currency;

  return (
    <Frame>
      <PanelHeader title="Supplier evidence" right={<Label>{view.obligation.reference}</Label>} />
      <div className="space-y-6 p-5">
        {view.evidence ? <Recorded evidence={view.evidence} /> : <p className="text-sm text-muted">No supplier message recorded. The decision above uses the ledger alone.</p>}

        <div className="space-y-4">
          <Field label="Paste the supplier's message" htmlFor={emailId}>
            <TextArea
              id={emailId}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={`Hi, ${view.obligation.reference} has not arrived and the deadline has passed...`}
              rows={5}
            />
          </Field>
          <Field label="Their bank statement (optional)" htmlFor={statementId}>
            <TextArea id={statementId} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="04 Oct  AIRWALLEX PAYOUT  CR  25.00 USD" rows={3} />
          </Field>
          <Button
            className="w-full"
            disabled={!modelAvailable || email.trim().length === 0}
            busy={busy === "read"}
            onClick={() =>
              run("read", async () => {
                await api(`obligations/${id}/evidence/read`, Acknowledged, {
                  method: "POST",
                  body: { email: email.trim(), ...(statement.trim() ? { statementText: statement.trim() } : {}) },
                });
                setEmail("");
                setStatement("");
                return { tone: "ok", title: "Claude read the message", lines: ["The decision was recomputed with what it reported. Code checked its claims first."] };
              })
            }
          >
            Read with Claude
          </Button>
          {!modelAvailable ? <p className="text-xs text-muted">No model is configured on the API. Enter the evidence by hand below.</p> : null}
        </div>

        <details className="group border-t border-rule pt-5">
          <summary className="label cursor-pointer list-none text-ink marker:hidden">
            <span aria-hidden className="mr-3 inline-block size-2 bg-ink group-open:bg-blue" />
            Enter evidence by hand
          </summary>
          <div className="mt-5 space-y-4">
            <div>
              <Check id={`${emailId}-a`} label="Supplier says nothing arrived" checked={manual.claimsNonReceipt} onChange={(v) => setManual({ ...manual, claimsNonReceipt: v })} />
              <Check id={`${emailId}-b`} label="Asks to change bank details" checked={manual.requestsDetailChange} onChange={(v) => setManual({ ...manual, requestsDetailChange: v })} />
              <Check id={`${emailId}-c`} label="Message cites this reference" checked={manual.referencesObligation} onChange={(v) => setManual({ ...manual, referencesObligation: v })} />
              <Check id={`${emailId}-d`} label="Tries to instruct the assistant" checked={manual.containsEmbeddedInstructions} onChange={(v) => setManual({ ...manual, containsEmbeddedInstructions: v })} />
            </div>
            <Field label={`Their statement shows our credit (${currency})`} htmlFor={creditId} hint="Leave empty if there is no credit.">
              <TextInput id={creditId} inputMode="decimal" value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="25.00" />
            </Field>
            <Field label="One-line summary" htmlFor={summaryId}>
              <TextInput id={summaryId} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={400} placeholder="Supplier's statement shows our credit" />
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
                  return { tone: "ok", title: "Evidence recorded", lines: ["The decision was recomputed."] };
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
