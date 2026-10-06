"use client";

import { useId, useState } from "react";
import { Acknowledged, api } from "@/lib/client-api";
import type { IncidentView } from "../../../src/server/wire";
import { Button, Frame, Label, PanelHeader } from "../ui";
import { Field, TextArea, TextInput, type Notice } from "./fields";

export interface RunAction {
  (key: string, work: () => Promise<Notice | void>): Promise<void>;
}

interface Props {
  view: IncidentView;
  operator: string;
  busy: string | null;
  run: RunAction;
}

export function ActionsPanel({ view, operator, busy, run }: Props) {
  const noteId = useId();
  const beneficiaryId = useId();
  const [note, setNote] = useState("");
  const [beneficiary, setBeneficiary] = useState("");

  const id = view.obligation.id;
  const latest = view.attempts.at(-1);
  const decision = view.assessment?.decision;
  const closed = view.obligation.status === "CLOSED";
  const canReplaceAuto = Boolean(decision?.allowed.includes("REPLACE") && decision.replacement?.autoApprovable);
  const refusedReplace = decision?.blocked.find((b) => b.action === "REPLACE")?.reason;
  const canRecover = decision?.recommended === "RECOVER_INTENT";
  const canClose = latest?.state === "PAID" && !closed;
  const canApprove = (latest?.state === "DEAD" || latest?.state === "ABANDONED") && !closed && note.trim().length > 0;

  return (
    <Frame>
      <PanelHeader title="Actions" right={<Label>{operator}</Label>} />
      <div className="space-y-8 p-5">
        <div className="space-y-3">
          <Button
            className="w-full"
            disabled={!canReplaceAuto}
            busy={busy === "replace"}
            onClick={() =>
              run("replace", async () => {
                const result = await api(`obligations/${id}/replace`, Acknowledged, { method: "POST" });
                return { tone: "ok", title: "Replacement sent", lines: [`Outcome ${String(result.outcome)} under a new request_id.`] };
              })
            }
          >
            Replace automatically
          </Button>
          {!canReplaceAuto ? (
            <p className="text-xs leading-relaxed text-muted">{refusedReplace ?? "Automatic replacement does not apply to this state."}</p>
          ) : null}

          {canRecover ? (
            <Button
              variant="secondary"
              className="w-full"
              busy={busy === "recover"}
              onClick={() =>
                run("recover", async () => {
                  await api(`obligations/${id}/recover`, Acknowledged, { method: "POST" });
                  return { tone: "ok", title: "Intent resolved", lines: ["Looked the attempt up by its request_id. No second payment was created."] };
                })
              }
            >
              Resolve pending intent
            </Button>
          ) : null}

          <Button
            variant="secondary"
            className="w-full"
            disabled={!canClose}
            busy={busy === "close"}
            onClick={() =>
              run("close", async () => {
                const result = await api(`obligations/${id}/close`, Acknowledged, { method: "POST" });
                return { tone: "ok", title: "Reconciled and certified", lines: [`Certificate ${String(result.hash).slice(0, 16)}...`] };
              })
            }
          >
            Close and certify
          </Button>
        </div>

        <div className="border-t border-rule pt-6">
          <Label className="text-ink">Human approval</Label>
          <p className="mb-4 mt-3 text-xs leading-relaxed text-muted">
            A named person can release a replacement the code will not. The note is recorded with your name and must say why.
          </p>
          <div className="space-y-4">
            <Field label="Why is this safe?" htmlFor={noteId}>
              <TextArea
                id={noteId}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Supplier's bank confirmed no credit, by callback to the number on file."
                maxLength={500}
              />
            </Field>
            <Field label="Corrected beneficiary id (optional)" htmlFor={beneficiaryId}>
              <TextInput id={beneficiaryId} value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} placeholder="Leave empty to keep the account" />
            </Field>
            <Button
              variant="secondary"
              className="w-full"
              disabled={!canApprove}
              busy={busy === "approve"}
              onClick={() =>
                run("approve", async () => {
                  const result = await api(`obligations/${id}/approve`, Acknowledged, {
                    method: "POST",
                    body: { note: note.trim(), ...(beneficiary.trim() ? { beneficiaryId: beneficiary.trim() } : {}) },
                  });
                  setNote("");
                  setBeneficiary("");
                  return { tone: "ok", title: "Approved and sent", lines: [`Outcome ${String(result.outcome)}. Recorded as ${operator}.`] };
                })
              }
            >
              Approve as {operator.split("@")[0]}
            </Button>
          </div>
        </div>
      </div>
    </Frame>
  );
}
