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
  const payeeId = useId();
  const [note, setNote] = useState("");
  const [payee, setPayee] = useState("");

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
                await api(`obligations/${id}/replace`, Acknowledged, { method: "POST" });
                return { tone: "ok", title: "Replacement sent", lines: ["A new payment was created under a fresh request ID. The original stays cancelled."] };
              })
            }
          >
            Replace the payment
          </Button>
          {!canReplaceAuto ? (
            <p className="text-xs leading-relaxed text-muted">{refusedReplace ?? "An automatic replacement does not apply in this state."}</p>
          ) : null}

          {canRecover ? (
            <Button
              variant="secondary"
              className="w-full"
              busy={busy === "recover"}
              onClick={() =>
                run("recover", async () => {
                  await api(`obligations/${id}/recover`, Acknowledged, { method: "POST" });
                  return { tone: "ok", title: "Request resolved", lines: ["Tessera looked the attempt up by its original request ID. No second payment was created."] };
                })
              }
            >
              Resolve the open request
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
            Reconcile and certify
          </Button>
        </div>

        <div className="border-t border-rule pt-6">
          <Label className="text-ink">Release a payment yourself</Label>
          <p className="mb-4 mt-3 text-xs leading-relaxed text-muted">
            Some replacements the code will never make on its own. A named person can release one, in writing. Your reason is
            recorded under your name.
          </p>
          <div className="space-y-4">
            <Field label="Why is it safe to pay again?" htmlFor={noteId}>
              <TextArea
                id={noteId}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="The supplier's bank confirmed by phone that no credit arrived."
                maxLength={500}
              />
            </Field>
            <Field label="Corrected payee ID, if the details changed" htmlFor={payeeId}>
              <TextInput id={payeeId} value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="Leave empty to keep the same account" />
            </Field>
            <Button
              variant="secondary"
              className="w-full"
              disabled={!canApprove}
              busy={busy === "approve"}
              onClick={() =>
                run("approve", async () => {
                  await api(`obligations/${id}/approve`, Acknowledged, {
                    method: "POST",
                    body: { note: note.trim(), ...(payee.trim() ? { beneficiaryId: payee.trim() } : {}) },
                  });
                  setNote("");
                  setPayee("");
                  return { tone: "ok", title: "Released and sent", lines: [`Approved by ${operator}. A new payment was created.`] };
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
