"use client";

import { useId, useState } from "react";
import { Acknowledged, api, ApiProblem } from "@/lib/client-api";
import { money, shortHash } from "@/lib/format";
import { ATTEMPT } from "@/lib/status";
import { AttemptResolvedSchema, EscalationResolvedSchema, type IncidentView } from "../../../src/server/wire";
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

/**
 * The API refuses a human action whose note is shorter than this (WRITTEN_NOTE_MIN_CHARS in src/approval/approval.ts,
 * which the browser cannot import). Mirrored here only so the button says why it is disabled.
 */
const NOTE_MIN = 10;
const noteHint = (note: string): string | undefined => {
  const missing = NOTE_MIN - note.trim().length;
  return missing > 0 ? `A written note: at least ${NOTE_MIN} characters (${missing} more).` : undefined;
};

/** One written note and a button: the shape of every human-only action on this panel. */
function NotedAction({
  label,
  hint,
  placeholder,
  button,
  busy,
  onSubmit,
}: {
  label: string;
  hint: string;
  placeholder: string;
  button: string;
  busy: boolean;
  onSubmit: (note: string) => Promise<boolean>;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted">{hint}</p>
      <Field label={label} htmlFor={noteId} hint={noteHint(note)}>
        <TextArea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} placeholder={placeholder} maxLength={500} />
      </Field>
      <Button
        variant="secondary"
        className="w-full"
        disabled={note.trim().length < NOTE_MIN}
        busy={busy}
        onClick={async () => {
          if (await onSubmit(note.trim())) setNote("");
        }}
      >
        {button}
      </Button>
    </div>
  );
}

export function ActionsPanel({ view, operator, busy, run }: Props) {
  const noteId = useId();
  const payeeId = useId();
  const [note, setNote] = useState("");
  const [payee, setPayee] = useState("");
  /** Step one of an approval pins the evidence hash the approver is looking at; step two sends exactly that hash. */
  const [reviewed, setReviewed] = useState<string | null>(null);

  const id = view.obligation.id;
  const latest = view.attempts.at(-1);
  const decision = view.assessment?.decision;
  const closed = view.obligation.status === "CLOSED";
  const escalated = view.obligation.status === "ESCALATED";
  const canReplaceAuto = Boolean(decision?.allowed.includes("REPLACE") && decision.replacement?.autoApprovable);
  const refusedReplace = decision?.blocked.find((b) => b.action === "REPLACE")?.reason;
  const canRecover = decision?.recommended === "RECOVER_INTENT";
  const canClose = Boolean(decision?.allowed.includes("CLOSE")) && !closed;
  const refusedClose = decision?.blocked.find((b) => b.action === "CLOSE")?.reason;
  const releasable = (latest?.state === "DEAD" || latest?.state === "ABANDONED") && !closed;
  const canReview = releasable && view.evidenceHash !== null && note.trim().length >= NOTE_MIN;
  const stuck = view.attempts.filter((a) => a.state === "INTENT" || a.state === "LIVE");
  const name = operator.split("@")[0];

  const approve = (evidenceHash: string) =>
    run("approve", async () => {
      try {
        await api(`obligations/${id}/approve`, Acknowledged, {
          method: "POST",
          body: { note: note.trim(), evidenceHash, ...(payee.trim() ? { beneficiaryId: payee.trim() } : {}) },
        });
      } catch (error) {
        if (error instanceof ApiProblem && error.problem.code === "stale_evidence") {
          // run() refreshes the page after this returns, so the operator re-reads the new recommendation first.
          return {
            tone: "refused",
            title: "The facts changed while you were reviewing",
            lines: [
              "Nothing was paid. Something reached the ledger after you opened the review, so the approval you signed no longer matches the incident.",
              "The page now shows the current recommendation. Read it again and approve only if it still holds.",
            ],
          };
        }
        throw error;
      } finally {
        setReviewed(null);
      }
      setNote("");
      setPayee("");
      return { tone: "ok", title: "Released and sent", lines: [`Approved by ${operator}. A new payment was created.`] };
    });

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
          {!canClose && !closed ? (
            <p className="text-xs leading-relaxed text-muted">{refusedClose ?? "Certifying is not one of the safe steps right now."}</p>
          ) : null}
        </div>

        {escalated ? (
          <div className="border-t border-rule pt-6">
            <Label className="text-ink">Take it back from escalation</Label>
            <div className="mt-3">
              <NotedAction
                label="What did you check?"
                hint={`Escalated: ${view.obligation.escalationReason ?? "no reason recorded"}. Clearing it returns the incident to the playbook; it moves no money. Your note is recorded under your name.`}
                placeholder="Called the supplier; they confirm the account and that nothing has arrived."
                button={`Resolve as ${name}`}
                busy={busy === "escalation"}
                onSubmit={async (text) => {
                  let ok = false;
                  await run("escalation", async () => {
                    const result = await api(`obligations/${id}/escalation/resolve`, EscalationResolvedSchema, { method: "POST", body: { note: text } });
                    ok = true;
                    return { tone: "ok", title: "Escalation resolved", lines: [`Resolved by ${operator}. The incident is now ${result.status.toLowerCase().replaceAll("_", " ")}.`] };
                  });
                  return ok;
                }}
              />
            </div>
          </div>
        ) : null}

        {stuck.map((attempt) => (
          <div key={attempt.id} className="border-t border-rule pt-6">
            <Label className="text-ink">
              Release the lock on attempt {String(attempt.seq).padStart(2, "0")} ({ATTEMPT[attempt.state].label.toLowerCase()})
            </Label>
            <div className="mt-3">
              <NotedAction
                label="Why should this lock be released?"
                hint={`Tessera first asks Airwallex again. It releases the lock only if Airwallex shows the transfer cancelled, or this attempt never reached Airwallex (no transfer exists for request ${shortHash(attempt.requestId, 8)} and the attempt is at least 10 minutes old, so a slow send cannot still land). A transfer waiting in an approval queue stays locked until it is cancelled, and a live ${money(attempt.amountMinor, attempt.currency)} transfer is never released.`}
                placeholder="Checked the Airwallex dashboard: no transfer was created for this request."
                button={`Release as ${name}`}
                busy={busy === `release-${attempt.id}`}
                onSubmit={async (text) => {
                  let ok = false;
                  await run(`release-${attempt.id}`, async () => {
                    const result = await api(`obligations/${id}/attempts/${attempt.id}/resolve`, AttemptResolvedSchema, { method: "POST", body: { note: text } });
                    ok = true;
                    return { tone: "ok", title: "Lock released", lines: [`Airwallex confirmed it; the attempt is now ${ATTEMPT[result.state].label.toLowerCase()}. Released by ${operator}.`] };
                  });
                  return ok;
                }}
              />
            </div>
          </div>
        ))}

        <div className="border-t border-rule pt-6">
          <Label className="text-ink">Release a payment yourself</Label>
          <p className="mb-4 mt-3 text-xs leading-relaxed text-muted">
            Some replacements the code will never make on its own. A named person can release one, in writing. You review
            first; the approval is bound to the facts you reviewed, so if anything changes in between it is refused.
          </p>
          <div className="space-y-4">
            <Field label="Why is it safe to pay again?" htmlFor={noteId} hint={noteHint(note)}>
              <TextArea
                id={noteId}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  setReviewed(null);
                }}
                placeholder="The supplier's bank confirmed by phone that no credit arrived."
                maxLength={500}
              />
            </Field>
            <Field label="Corrected payee ID, if the details changed" htmlFor={payeeId}>
              <TextInput
                id={payeeId}
                value={payee}
                onChange={(e) => {
                  setPayee(e.target.value);
                  setReviewed(null);
                }}
                placeholder="Leave empty to keep the same account"
              />
            </Field>
            {reviewed === null ? (
              <>
                <Button variant="secondary" className="w-full" disabled={!canReview} onClick={() => setReviewed(view.evidenceHash)}>
                  Review the release
                </Button>
                {releasable && view.evidenceHash === null ? (
                  <p className="text-xs leading-relaxed text-muted">The assessment failed, so there is nothing to approve against. {view.assessmentError ?? ""}</p>
                ) : null}
              </>
            ) : (
              <div className="space-y-3 rounded-2xl border border-white/20 p-4">
                <Label className="text-ink">You are approving</Label>
                <ul className="space-y-1.5 text-sm leading-relaxed">
                  <li>
                    A new payment of <strong className="tnum">{money(view.obligation.amountMinor, view.obligation.currency)}</strong> for{" "}
                    {view.obligation.reference}
                  </li>
                  <li>To {payee.trim() ? <span className="font-mono text-[13px]">{payee.trim()}</span> : "the same payee as before"}</li>
                  <li>Recommended step at review: {decision?.recommended.toLowerCase().replaceAll("_", " ") ?? "none"}</li>
                  <li>
                    Facts fingerprint <span className="font-mono text-[12px]">{shortHash(reviewed, 16)}</span>
                  </li>
                </ul>
                <div className="grid grid-cols-2 gap-3">
                  <Button variant="secondary" disabled={busy === "approve"} onClick={() => setReviewed(null)}>
                    Back
                  </Button>
                  <Button busy={busy === "approve"} onClick={() => void approve(reviewed)}>
                    Approve as {name}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Frame>
  );
}
