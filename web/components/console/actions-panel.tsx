"use client";

import { useId, useState, type ReactNode } from "react";
import { Acknowledged, api, ApiProblem } from "@/lib/client-api";
import { money, shortHash } from "@/lib/format";
import { ATTEMPT } from "@/lib/status";
import { AttemptResolvedSchema, EscalationResolvedSchema, type IncidentView } from "../../../src/server/wire";

import { DraftPanel } from "./draft-panel";
import { Field, Fold, TextArea, TextInput, type Notice } from "./fields";
import { CardPanel } from "./card-panel";
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
      <p className="text-[13px] leading-relaxed text-fg/60">{hint}</p>
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

/** The one card at the top of Decide: what should happen now, in a sentence, with the button that does it. */
function Now({ kicker, title, children, tone = "accent" }: { kicker: string; title: string; children: ReactNode; tone?: "accent" | "warn" | "quiet" }) {
  const ring = tone === "accent" ? "ring-2 ring-accent/70" : tone === "warn" ? "ring-2 ring-warn/60" : "ring-1 ring-fg/10";
  return (
    <section className={`tile space-y-3 rounded-[22px]! p-4 ${ring}`}>
      <div>
        <span className="kicker block">{kicker}</span>
        <h3 className="mt-1 text-[18.5px] font-semibold leading-snug tracking-[-0.02em]">{title}</h3>
      </div>
      {children}
    </section>
  );
}

/** One way to pay the invoice again, stacked above the other. */
function Rail({ title, facts, children, open }: { title: string; facts: string[]; children: ReactNode; open: boolean }) {
  return (
    <div className={`flex flex-col gap-2.5 rounded-[18px] p-3.5 ${open ? "well" : "well opacity-60"}`}>
      <p className="text-[15px] font-semibold">{title}</p>
      <ul className="space-y-1">
        {facts.map((f) => (
          <li key={f} className="flex gap-2 text-[13.5px] leading-snug text-fg/65">
            <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-fg/40" />
            {f}
          </li>
        ))}
      </ul>
      {children}
    </div>
  );
}

/**
 * Everything a person can do on an incident, in the order they would reach for it: a draft to send, then what should
 * happen now (and, when the invoice may be paid again, the two ways to do it: a transfer, or a single-use Visa card the
 * agent pays through Visa TAP), then the moves that need a signature, each folded until it is wanted.
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
  const allowed = decision?.allowed ?? [];
  const canReplaceAuto = Boolean(allowed.includes("REPLACE") && decision?.replacement?.autoApprovable);
  const canCard = allowed.includes("PAY_BY_CARD");
  const refusedReplace = decision?.blocked.find((b) => b.action === "REPLACE")?.reason;
  const canRecover = decision?.recommended === "RECOVER_INTENT";
  const canClose = allowed.includes("CLOSE") && !closed;
  const releasable = (latest?.state === "DEAD" || latest?.state === "ABANDONED") && !closed;
  const canReview = releasable && view.evidenceHash !== null && note.trim().length >= NOTE_MIN;
  const stuck = view.attempts.filter((a) => a.state === "INTENT" || a.state === "LIVE");
  const funding = Boolean(decision?.funding) || view.conversions.length > 0;
  const name = operator.split("@")[0];
  const clean = (reason: string | undefined) => reason?.replace(/agent:[\w-]+:\s*/g, "");
  const amount = money(view.obligation.amountMinor, view.obligation.currency);
  const card = view.invoiceCard ?? null;
  const cardHolds = card !== null && ["PENDING", "ISSUING", "ACTIVE", "FROZEN", "SPENT"].includes(card.state);
  const supplier = view.story?.supplier.legalName ?? "the supplier";
  // Airwallex answers "Invalid issuance details" when Issuing is not enabled for the business: say so, do not offer it again.
  const issuingOff = card?.state === "FAILED" && /issuance/i.test(card.lastError ?? "");
  const cardOpen = canCard && !issuingOff;
  const firstReason = clean(decision?.reasons[0]);
  // The money reached the supplier, and only their word (or an escalation over it) is open: a person can settle it.
  const delivered = latest?.state === "PAID" || (card !== null && card.spentMinor > 0);
  const disputed = Boolean(view.evidence?.evidence.claimsNonReceipt || view.evidence?.evidence.requestsDetailChange) || escalated;
  const confirmable = delivered && !closed && disputed;

  const replace = () =>
    run("replace", async () => {
      await api(`obligations/${id}/replace`, Acknowledged, { method: "POST" });
      return { tone: "ok", title: "Replacement sent", lines: ["New transfer under a fresh request ID. The original stays cancelled."] };
    });
  const askCard = () =>
    run("card", async () => {
      await api(`obligations/${id}/card`, Acknowledged, { method: "POST", body: {} });
      return { tone: "ok", title: "Card requested", lines: [`A single-use Visa card for exactly ${amount} waits for your signature. No transfer can be made while it holds the invoice.`] };
    });
  const certify = () =>
    run("close", async () => {
      const result = await api(`obligations/${id}/close`, Acknowledged, { method: "POST" });
      return { tone: "ok", title: "Reconciled and certified", lines: [`Certificate ${String(result.hash).slice(0, 16)}…`] };
    });

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

  /** What should happen now, decided by policy on the ledger as it stands. */
  function now(): ReactNode {
    if (closed) {
      return (
        <Now kicker="Done" title="Certified. Nothing left to do." tone="quiet">
          <p className="text-[14px] leading-relaxed text-fg/65">The certificate is under Evidence, sealed to the history that produced it.</p>
        </Now>
      );
    }
    if (cardHolds) {
      return <CardPanel view={view} operator={operator} busy={busy} run={run} />;
    }
    if ((allowed.includes("REPLACE") || canCard) && latest?.state === "DEAD") {
      return (
        <Now kicker="Now" title={`Pay it again, once: ${amount}`}>
          <p className="text-[14px] leading-relaxed text-fg/65">{firstReason ?? "The first payment is cancelled and the money is back."} Choose how the second payment travels; either one holds the invoice so it can only be paid once.</p>
          <div className="grid gap-2.5">
            <Rail
              title="Bank transfer"
              open={canReplaceAuto}
              facts={["To the account on file, under a fresh request ID", "Arrives within the usual settlement window", canReplaceAuto ? "Within the automatic limit" : (clean(refusedReplace) ?? "Needs a signature")]}
            >
              <Btn block disabled={!canReplaceAuto || busy !== null} busy={busy === "replace"} onClick={() => void replace()}>
                Send replacement
              </Btn>
            </Rail>
            <Rail
              title="Single-use Visa card"
              open={cardOpen}
              facts={[
                `Exactly ${amount}, payable only to ${supplier}`,
                "You sign it; the agent pays through Visa TAP",
                issuingOff ? "Card issuing isn't enabled on this Airwallex account" : canCard ? "Clears in minutes" : "Not offered for this invoice",
              ]}
            >
              <Btn block tone="secondary" disabled={!cardOpen || busy !== null} busy={busy === "card"} onClick={() => void askCard()}>
                Pay by Visa card
              </Btn>
            </Rail>
          </div>
          {card && !cardHolds && !issuingOff ? <p className="text-[13px] text-fg/55">The last card was {card.state.toLowerCase()}{card.lastError ? `: ${card.lastError}` : ""}.</p> : null}
        </Now>
      );
    }
    if (decision?.recommended === "FUND" && funding) {
      return (
        <Now kicker="Now" title="Fund the replacement, then send it">
          <p className="text-[14px] leading-relaxed text-fg/65">{firstReason}</p>
          <FundingPanel view={view} operator={operator} busy={busy} run={run} />
        </Now>
      );
    }
    if (canClose) {
      return (
        <Now kicker="Now" title="Reconcile and certify">
          <p className="text-[14px] leading-relaxed text-fg/65">Paid and through its hold window. Tessera matches every wallet line against Airwallex, then signs the certificate.</p>
          <Btn busy={busy === "close"} disabled={busy !== null} onClick={() => void certify()}>
            Certify
          </Btn>
        </Now>
      );
    }
    if (canRecover) {
      return (
        <Now kicker="Now" title="Settle the open request">
          <p className="text-[14px] leading-relaxed text-fg/65">Airwallex never answered. Tessera looks the attempt up by its original request ID; it never sends a second one.</p>
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
        </Now>
      );
    }
    if (escalated || decision?.recommended === "ESCALATE") {
      return (
        <Now kicker="Now" title="Yours to decide" tone="warn">
          <p className="text-[14px] leading-relaxed text-fg/65">{firstReason ?? "Policy will not settle this alone."} Nothing moves until you sign one of the moves below.</p>
        </Now>
      );
    }
    if (decision?.recommended === "SEND_PROOF_TO_SUPPLIER" || decision?.recommended === "SEND_STATUS_TO_SUPPLIER" || decision?.recommended === "REQUEST_CORRECTION") {
      return (
        <Now kicker="Now" title="Write to the supplier" tone="quiet">
          <p className="text-[14px] leading-relaxed text-fg/65">{firstReason} The agent can draft the reply under Ask the agent; a person sends it.</p>
        </Now>
      );
    }
    return (
      <Now kicker="Now" title="Nothing to do yet" tone="quiet">
        <p className="text-[14px] leading-relaxed text-fg/65">{firstReason ?? "No move is needed right now."}</p>
        {decision?.recheckAt ? <p className="text-[13px] text-fg/50">Tessera looks again at {new Date(decision.recheckAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p> : null}
      </Now>
    );
  }

  return (
    <div className="space-y-5">
      <DraftPanel view={view} busy={busy} run={run} />

      {now()}

      <div>
        <span className="kicker block">Moves that need your signature</span>
        <div className="mt-2.5 space-y-2">
          {confirmable ? (
            <Fold title="Confirm it arrived" sub="The supplier says they have it. Settles their claim; moves no money." open tone="accent">
              <NotedAction
                label="How did you confirm it?"
                hint="Your word, under your name, is what settles a supplier's claim: a message cannot. If the invoice was handed over, this takes it back too. Tessera certifies it once the hold window has passed."
                placeholder="Called the supplier on the number we hold: the payment is on their statement."
                button={`Sign as ${name}: it arrived`}
                busy={busy === "received"}
                onSubmit={async (text) => {
                  let ok = false;
                  await run("received", async () => {
                    await api(`obligations/${id}/received`, Acknowledged, { method: "POST", body: { note: text } });
                    ok = true;
                    return { tone: "ok", title: "Confirmed received", lines: [`Signed by ${operator}. Tessera certifies it once the hold window has passed.`] };
                  });
                  return ok;
                }}
              />
            </Fold>
          ) : null}
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
                    for request <span className="readout text-[12.5px] text-fg/80">{shortHash(attempt.requestId, 8)}</span>, and at least ten minutes old, so a slow send cannot still
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

          {funding && decision?.recommended !== "FUND" ? (
            <Fold title="Fund the replacement" sub="Convert from another wallet, within the policy's floors">
              <FundingPanel view={view} operator={operator} busy={busy} run={run} />
            </Fold>
          ) : null}

          <Fold title="Pay again, in writing" sub={releasable ? "Release a replacement policy would not make alone" : "Opens once the last attempt has ended"}>
            <div className="space-y-3">
              <p className="text-[13px] leading-relaxed text-fg/60">
                Some replacements policy will never make on its own. An authorized individual may release one, in writing. You review first, and your approval is bound to the exact facts you
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
                    <p className="text-[13px] leading-relaxed text-fg/55">The assessment failed, so there is nothing to approve against. {view.assessmentError ?? ""}</p>
                  ) : null}
                </>
              ) : (
                <div className="space-y-3 rounded-2xl border border-fg/15 well p-4">
                  <p className="text-[13.5px] font-medium">You are approving</p>
                  <ul className="space-y-1 text-[13.5px] leading-relaxed text-fg/80">
                    <li>
                      A new payment of <strong className="tnum text-fg">{money(view.obligation.amountMinor, view.obligation.currency)}</strong> for {view.obligation.reference}
                    </li>
                    <li>To {payee.trim() ? <span className="readout text-[13px]">{payee.trim()}</span> : "the same payee as before"}</li>
                    <li>Recommended at review: {decision?.recommended.toLowerCase().replaceAll("_", " ") ?? "nothing"}</li>
                    <li>
                      Facts fingerprint <span className="readout text-[12.5px]">{shortHash(reviewed, 16)}</span>
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
