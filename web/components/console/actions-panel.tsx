"use client";

import { useId, useState, type ReactNode } from "react";
import { Acknowledged, api, ApiProblem } from "@/lib/client-api";
import { money, shortHash } from "@/lib/format";
import { ATTEMPT } from "@/lib/status";
import { AttemptResolvedSchema, EscalationResolvedSchema, type IncidentView } from "../../../src/server/wire";

import { DraftPanel } from "./draft-panel";
import { Field, Fold, TextArea, TextInput, type Notice } from "./fields";
import { FundingPanel } from "./funding-panel";
import { Btn } from "../kit/metal";

export type { RunAction } from "@/lib/use-incident";
import type { RunAction } from "@/lib/use-incident";

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
  return missing > 0 ? `A sentence or two, in your own words (${missing} more character${missing === 1 ? "" : "s"}).` : undefined;
};

/** One written note and a button: the shape of every move that needs a person's signature. */
function NotedAction({
  label,
  hint,
  placeholder,
  button,
  busy,
  onSubmit,
}: {
  label: string;
  hint: ReactNode;
  placeholder: string;
  button: string;
  busy: boolean;
  onSubmit: (note: string) => Promise<boolean>;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-relaxed text-fg/60">{hint}</p>
      <Field label={label} htmlFor={noteId} hint={noteHint(note)}>
        <TextArea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} placeholder={placeholder} maxLength={500} />
      </Field>
      <Btn
        block
        disabled={note.trim().length < NOTE_MIN}
        busy={busy}
        onClick={async () => {
          if (await onSubmit(note.trim())) setNote("");
        }}
      >
        {button}
      </Btn>
    </div>
  );
}

/** One move the code can make on its own: what it is, why it is (or is not) open, and the button. */
function Move({ title, why, open, children }: { title: string; why: string; open: boolean; children: ReactNode }) {
  return (
    <li className={`flex items-center gap-4 rounded-[20px] px-4 py-3 ${open ? "tile ring-1 ring-accent/30" : "well"}`}>
      <span className="min-w-0 flex-1">
        <span className={`flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em] ${open ? "text-fg" : "text-fg/65"}`}>
          <span aria-hidden className={`size-1.5 rounded-full ${open ? "bg-accent" : "bg-fg/25"}`} />
          {title}
        </span>
        <span className="mt-0.5 block text-[12px] leading-snug text-fg/55">{why}</span>
      </span>
      <span className="shrink-0">{children}</span>
    </li>
  );
}

/**
 * Everything a person can do on an incident, in the order they would reach for it: a draft to send, the moves the code
 * can make by itself, and then the moves that need a signature, each folded until it is wanted.
 */
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
  const funding = Boolean(decision?.funding) || view.conversions.length > 0;
  const name = operator.split("@")[0];
  const clean = (reason: string | undefined) => reason?.replace(/agent:[\w-]+:\s*/g, "");

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
            title: "The facts moved while you were reading",
            lines: [
              "Nothing was paid. Something reached the ledger after you opened the review, so the approval you signed no longer describes this incident.",
              "The recommendation has been refreshed. Read it again, and approve only if it still holds.",
            ],
          };
        }
        throw error;
      } finally {
        setReviewed(null);
      }
      setNote("");
      setPayee("");
      return { tone: "ok", title: "Released and sent", lines: [`Approved by ${operator}. A new payment is on its way.`] };
    });

  return (
    <div className="space-y-5">
      <DraftPanel view={view} busy={busy} run={run} />

      <div>
        <span className="kicker block">Moves policy allows</span>
        <ul className="mt-2.5 space-y-2">
          <Move
            title="Replace the payment"
            open={canReplaceAuto}
            why={
              canReplaceAuto
                ? "Within the automatic limit. The original stays cancelled; the new one gets a fresh request ID."
                : (clean(refusedReplace) ?? "An automatic replacement does not apply here.")
            }
          >
            <Btn
              tone={canReplaceAuto ? "primary" : "secondary"}
              disabled={!canReplaceAuto}
              busy={busy === "replace"}
              onClick={() =>
                run("replace", async () => {
                  await api(`obligations/${id}/replace`, Acknowledged, { method: "POST" });
                  return { tone: "ok", title: "Replacement sent", lines: ["A new payment is on its way under a fresh request ID. The original stays cancelled."] };
                })
              }
            >
              Replace
            </Btn>
          </Move>

          {canRecover ? (
            <Move title="Settle the open request" open why="Tessera looks the attempt up by its original request ID. It will never send a second one.">
              <Btn
                busy={busy === "recover"}
                onClick={() =>
                  run("recover", async () => {
                    await api(`obligations/${id}/recover`, Acknowledged, { method: "POST" });
                    return { tone: "ok", title: "Request settled", lines: ["Found by its original request ID. No second payment was created."] };
                  })
                }
              >
                Settle
              </Btn>
            </Move>
          ) : null}

          <Move
            title="Reconcile and certify"
            open={canClose}
            why={
              closed
                ? "Already certified. The certificate sits under The evidence."
                : canClose
                  ? "Match every wallet line against Airwallex, then seal the certificate."
                  : (clean(refusedClose) ?? "Certifying is not yet among the safe moves.")
            }
          >
            <Btn
              tone={canClose ? "primary" : "secondary"}
              disabled={!canClose}
              busy={busy === "close"}
              onClick={() =>
                run("close", async () => {
                  const result = await api(`obligations/${id}/close`, Acknowledged, { method: "POST" });
                  return { tone: "ok", title: "Reconciled and certified", lines: [`Certificate ${String(result.hash).slice(0, 16)}…`] };
                })
              }
            >
              Certify
            </Btn>
          </Move>
        </ul>
      </div>

      <div>
        <span className="kicker block">Moves that need your signature</span>
        <div className="mt-2.5 space-y-2">
          {escalated ? (
            <Fold title="Take it back from escalation" sub="Return it to the playbook. Moves no money." open tone="accent">
              <NotedAction
                label="What did you check?"
                hint="Clearing the escalation hands the incident back to the playbook, which will weigh it afresh. It moves no money, and your note is kept in the ledger under your name."
                placeholder="Called the supplier: they confirm the account, and nothing has arrived yet."
                button={`Sign and take it back as ${name}`}
                busy={busy === "escalation"}
                onSubmit={async (text) => {
                  let ok = false;
                  await run("escalation", async () => {
                    const result = await api(`obligations/${id}/escalation/resolve`, EscalationResolvedSchema, { method: "POST", body: { note: text } });
                    ok = true;
                    return { tone: "ok", title: "Taken back", lines: [`Signed by ${operator}. The incident is now ${result.status.toLowerCase().replaceAll("_", " ")}.`] };
                  });
                  return ok;
                }}
              />
            </Fold>
          ) : null}

          {stuck.map((attempt) => (
            <Fold
              key={attempt.id}
              title={`Release the lock on attempt ${String(attempt.seq).padStart(2, "0")}`}
              sub={`${ATTEMPT[attempt.state].label}. Lifts only if Airwallex confirms nothing is in flight.`}
            >
              <NotedAction
                label="Why should this lock be released?"
                hint={
                  <>
                    Tessera asks Airwallex once more before it lets go. The lock lifts only if the transfer shows as cancelled, or if this attempt never reached Airwallex at all: no transfer
                    for request <span className="readout text-[11.5px] text-fg/80">{shortHash(attempt.requestId, 8)}</span>, and at least ten minutes old, so a slow send cannot still
                    land. A transfer waiting in an approval queue stays locked until it is cancelled, and a live {money(attempt.amountMinor, attempt.currency)} transfer is never released.
                  </>
                }
                placeholder="Checked the Airwallex dashboard: no transfer was ever created for this request."
                button={`Sign and release as ${name}`}
                busy={busy === `release-${attempt.id}`}
                onSubmit={async (text) => {
                  let ok = false;
                  await run(`release-${attempt.id}`, async () => {
                    const result = await api(`obligations/${id}/attempts/${attempt.id}/resolve`, AttemptResolvedSchema, { method: "POST", body: { note: text } });
                    ok = true;
                    return { tone: "ok", title: "Lock released", lines: [`Airwallex confirmed it; the attempt is now ${ATTEMPT[result.state].label.toLowerCase()}. Signed by ${operator}.`] };
                  });
                  return ok;
                }}
              />
            </Fold>
          ))}

          {funding ? (
            <Fold title="Fund the replacement" sub="Convert from another wallet, within the policy's floors">
              <FundingPanel view={view} operator={operator} busy={busy} run={run} />
            </Fold>
          ) : null}

          <Fold title="Pay again, in writing" sub={releasable ? "Release a replacement policy would not make alone" : "Opens once the last attempt has ended"}>
            <div className="space-y-3">
              <p className="text-[12px] leading-relaxed text-fg/60">
                Some replacements policy will never make on its own. A named person may release one, in writing. You review first, and your approval is bound to the exact facts you
                reviewed: if anything shifts in between, it is refused.
              </p>
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
              <Field label="Corrected payee ID, only if the details changed" htmlFor={payeeId}>
                <TextInput
                  id={payeeId}
                  value={payee}
                  onChange={(e) => {
                    setPayee(e.target.value);
                    setReviewed(null);
                  }}
                  placeholder="Leave empty to pay the same account"
                />
              </Field>
              {reviewed === null ? (
                <>
                  <Btn tone="secondary" block disabled={!canReview} onClick={() => setReviewed(view.evidenceHash)}>
                    Review before signing
                  </Btn>
                  {releasable && view.evidenceHash === null ? (
                    <p className="text-[12px] leading-relaxed text-fg/55">The assessment failed, so there is nothing to approve against. {view.assessmentError ?? ""}</p>
                  ) : null}
                </>
              ) : (
                <div className="space-y-3 rounded-2xl border border-fg/15 well p-4">
                  <p className="text-[12.5px] font-medium">You are approving</p>
                  <ul className="space-y-1 text-[12.5px] leading-relaxed text-fg/80">
                    <li>
                      A new payment of <strong className="tnum text-fg">{money(view.obligation.amountMinor, view.obligation.currency)}</strong> for {view.obligation.reference}
                    </li>
                    <li>To {payee.trim() ? <span className="readout text-[12px]">{payee.trim()}</span> : "the same payee as before"}</li>
                    <li>Recommended at review: {decision?.recommended.toLowerCase().replaceAll("_", " ") ?? "nothing"}</li>
                    <li>
                      Facts fingerprint <span className="readout text-[11.5px]">{shortHash(reviewed, 16)}</span>
                    </li>
                  </ul>
                  <div className="grid grid-cols-2 gap-2">
                    <Btn tone="secondary" disabled={busy === "approve"} onClick={() => setReviewed(null)}>
                      Back
                    </Btn>
                    <Btn busy={busy === "approve"} onClick={() => void approve(reviewed)}>
                      Sign as {name}
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          </Fold>
        </div>
      </div>
    </div>
  );
}
