/**
 * A case: a supplier's problem, every move made on it since, and where it stands. The board shows it as a lane, red
 * where it starts and green where it lands.
 *
 * Only the problem is written by hand: the CASE_OPENED brief (src/demo/morning.ts) says what the supplier is facing. Each
 * step after it is read from the ledger event that recorded it (the agent's tool calls and the policy's answers, a
 * person's signatures, Airwallex and Visa), and the outcome from the state the ledger is in. Nothing is stored, so a lane
 * can never say more than happened, and a refusal is shown as one.
 */
import { z } from "zod";
import { CardCheckoutPayloadSchema } from "../cards/checkout-event";
import { DraftRecordedSchema, DraftResolvedSchema, pendingDraft, repliesSentSince } from "../commander/drafts";
import { EvidenceRecordedSchema, type SupplierEvidence } from "../commander/evidence";
import { TransferStatusPayloadSchema } from "../ledger/events";
import { CardDecidedSchema, CardIssuedSchema, CardRequestedSchema } from "../ledger/cards";
import type { Attempt, LedgerEvent, Obligation } from "../ledger/ledger";
import { formatMinor } from "../money";
import type { Case, CaseOutcome, CaseStep } from "./wire";

export const CaseOpenedSchema = z.looseObject({
  kind: z.string(),
  problem: z.object({ headline: z.string(), detail: z.string() }),
});

export interface CaseInput {
  obligation: Pick<Obligation, "status" | "amountMinor" | "currency" | "escalationReason">;
  attempts: Pick<Attempt, "seq" | "state" | "awxStatus" | "failureCode">[];
  events: LedgerEvent[];
  /** The card holding the invoice's lock, if one does. */
  card: { state: string; spentMinor: number; merchant: string } | null;
  evidence: SupplierEvidence | null;
  /** The supplier as people say it: "Modal". */
  who: string;
}

/** The policy's calls, in the words a step says them. */
const CALL: Record<string, { short: string; words: string }> = {
  REPLACE: { short: "replace", words: "replace the payment" },
  PAY_BY_CARD: { short: "Visa card", words: "pay by single-use Visa card" },
  FUND: { short: "fund", words: "fund the replacement first" },
  WAIT: { short: "wait", words: "wait; paying again could pay twice" },
  ESCALATE: { short: "hand off", words: "hand it to a person" },
  CLOSE: { short: "certify", words: "certify it" },
  SEND_PROOF_TO_SUPPLIER: { short: "send proof", words: "send proof of payment, never a second payment" },
  SEND_STATUS_TO_SUPPLIER: { short: "update", words: "tell the supplier where it is" },
  REQUEST_CORRECTION: { short: "ask details", words: "ask for corrected details" },
  RECOVER_INTENT: { short: "settle", words: "settle the open request by its ID" },
  NONE: { short: "nothing", words: "nothing to do" },
};

/** What a refused move was trying to do. */
const TRIED: Record<string, string> = {
  replace_payment: "pay it again",
  pay_invoice_by_card: "pay it by card as well",
  reconcile_and_close: "certify it early",
  fund_replacement: "convert currency for it",
  draft_supplier_reply: "draft a reply with bank details",
  read_supplier_message: "pass off a forged message",
  escalate_to_human: "hand it over",
  defer_incident: "defer it",
};

const REPLY: Record<string, string> = { STATUS: "status", PROOF: "proof-of-payment", CORRECTION: "correction" };

const ToolCallSchema = z.looseObject({
  actor: z.string(),
  tool: z.string(),
  outcome: z.string(),
  detail: z.string().nullable().optional(),
  verdict: z.object({ recommended: z.string(), reasons: z.array(z.string()) }).nullable().optional(),
});
const IntentSchema = z.looseObject({ mode: z.string().optional(), approver: z.string().optional(), note: z.string().nullable().optional(), replaces: z.string().nullable().optional() });
const ReasonSchema = z.looseObject({ reason: z.string() });
const NoteSchema = z.looseObject({ note: z.string(), by: z.string() });
const RefusedSchema = z.looseObject({ by: z.string(), message: z.string() });
const InboxSchema = z.looseObject({ from: z.string() });
const ClosedSchema = z.looseObject({ certificateHash: z.string().optional() });

/** "agent:scripted: The supplier's message…" reads as "The supplier's message…". */
const unprefixed = (text: string): string => text.replace(/^(?:agent|policy):[\w-]+:\s*/, "").replace(/agent:[\w-]+:\s*/g, "");
/** The first sentence or two of a reason, without a trailing stop, short enough for a lane. */
function sentence(text: string, max = 170): string {
  const clean = unprefixed(text).replace(/obligation [0-9a-f-]{36}:?\s*/gi, "").replace(/\s+/g, " ").trim();
  const first = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  const cut = first.length > max ? `${first.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : first;
  return cut.replace(/[.\s]+$/, "");
}
/** A person's words, quoted, ending the sentence once. */
const quoted = (note: string): string => `“${note.trim().replace(/[.\s]+$/, "")}.”`;
/** Why policy refused, from the error it raised: the reason, not the plumbing around it. */
function refusal(detail: string): string {
  const reason = detail
    .replace(/obligation [0-9a-f-]{36}:?\s*/gi, "")
    .replace(/^[^:]*?refused(?: \([^)]*\))?:\s*/i, "")
    .replace(/^.*?cannot be closed:\s*-\s*/s, "")
    .replace(/^this draft was refused:\s*/i, "");
  return sentence(reason);
}
const person = (by: string): string => (by.includes("@") ? by.split("@")[0]! : by);
const agentActor = (actor: string): CaseStep["actor"] => (actor === "agent:adversary" ? "test" : actor.startsWith("agent:") ? "agent" : "you");

/** The flags a reading found, as the step says them. */
function readFlags(evidence: SupplierEvidence): string {
  const flags = [
    evidence.claimsNonReceipt && "says it hasn't arrived",
    evidence.requestsDetailChange && "asks to pay a different bank account",
    evidence.containsEmbeddedInstructions && "carries orders aimed at the agent, ignored",
    !evidence.referencesObligation && "doesn't cite the invoice",
  ].filter((f): f is string => typeof f === "string");
  return flags.length > 0 ? flags.join("; ") : "nothing unusual";
}

/** Every move after the case opened, oldest first, as steps; repeats in a row fold into one with a count. */
export function caseSteps(after: LedgerEvent[], input: Pick<CaseInput, "who" | "obligation">): CaseStep[] {
  const steps: Array<Omit<CaseStep, "count"> & { tried?: string }> = [];
  const amount = formatMinor(input.obligation.amountMinor, input.obligation.currency);
  const push = (e: LedgerEvent, step: Pick<CaseStep, "actor" | "kind" | "label" | "text"> & { tried?: string }) => steps.push({ seq: e.seq, at: e.ts, ...step });
  const drafts = new Map<number, string>();

  after.forEach((e, i) => {
    switch (e.type) {
      case "EVIDENCE_RECORDED": {
        const p = EvidenceRecordedSchema.safeParse(e.payload);
        if (!p.success) return;
        if (p.data.source === "manual") {
          push(e, { actor: "you", kind: "read", label: "Entered facts", text: `${person(p.data.enteredBy)} entered what ${input.who} says by hand.` });
          return;
        }
        const actor = agentActor(p.data.enteredBy);
        push(e, { actor, kind: "read", label: "Read email", text: `Read ${input.who}'s email through the quarantined reader: ${readFlags(p.data.evidence)}.` });
        return;
      }
      case "AGENT_TOOL_CALL": {
        const p = ToolCallSchema.safeParse(e.payload);
        if (!p.success) return;
        const actor = agentActor(p.data.actor);
        if (p.data.outcome !== "ok") {
          const tried = TRIED[p.data.tool] ?? p.data.tool.replaceAll("_", " ");
          const why = p.data.detail ? refusal(p.data.detail) : "";
          push(e, { actor, kind: "refused", label: "Refused", tried, text: `Tried to ${tried}. Policy refused${why ? `: ${why}` : ""}.` });
          return;
        }
        // A test that is told to break the rules is shown only where it was stopped.
        if (actor === "test") return;
        if (p.data.tool === "assess_incident" && p.data.verdict) {
          const { recommended, reasons } = p.data.verdict;
          const call = CALL[recommended] ?? { short: recommended.toLowerCase(), words: recommended.toLowerCase() };
          const reason = reasons[recommended === "PAY_BY_CARD" ? reasons.length - 1 : 0];
          push(e, { actor, kind: "check", label: `Checked: ${call.short}`, text: `Checked Airwallex and asked the policy${reason ? `: ${sentence(reason)}` : ""}. The call: ${call.words}.` });
        }
        return;
      }
      case "ATTEMPT_INTENT": {
        const p = IntentSchema.safeParse(e.payload);
        if (!p.success || !p.data.replaces) return;
        if (p.data.mode === "HUMAN") {
          push(e, { actor: "you", kind: "release", label: "Released", text: `${person(p.data.approver ?? "A person")} released a second payment in writing: ${quoted(p.data.note ?? "")}` });
          return;
        }
        // An automatic replacement: the agent's, if its call follows; otherwise a person pressed Replace.
        const byAgent = after.slice(i + 1, i + 4).some((x) => x.type === "AGENT_TOOL_CALL" && ToolCallSchema.safeParse(x.payload).data?.tool === "replace_payment");
        push(e, {
          actor: byAgent ? "agent" : "you", kind: "act", label: "Replaced",
          text: `Sent a replacement under a fresh request ID, within the automatic limit. The original stays cancelled.`,
        });
        return;
      }
      case "TRANSFER_STATUS": {
        const p = TransferStatusPayloadSchema.safeParse(e.payload);
        if (!p.success) return;
        if (p.data.to === "PAID") push(e, { actor: "airwallex", kind: "paid", label: "Landed", text: `The transfer landed. ${input.who} is paid.` });
        else if (p.data.to === "CANCELLED") push(e, { actor: "airwallex", kind: "fail", label: "Cancelled", text: `Cancelled the transfer${p.data.failureCode ? ` (${p.data.failureCode})` : ""}.` });
        return;
      }
      case "AGENT_DEFERRED": {
        const p = z.looseObject({ actor: z.string(), note: z.string() }).safeParse(e.payload);
        if (!p.success) return;
        const why = sentence(p.data.note.replace(/^The assessment recommends waiting(?: until \S+?Z)?:\s*/, ""));
        push(e, { actor: agentActor(p.data.actor), kind: "hold", label: "Held", text: `Held. ${why}. Paying again now could pay ${input.who} twice.` });
        return;
      }
      case "ESCALATED": {
        const p = ReasonSchema.safeParse(e.payload);
        if (!p.success) return;
        push(e, { actor: /^agent:/.test(p.data.reason) ? "agent" : "tessera", kind: "handoff", label: "To you", text: `Handed to a person: ${sentence(p.data.reason, 200)}.` });
        return;
      }
      case "ESCALATION_RESOLVED": {
        const p = NoteSchema.safeParse(e.payload);
        if (p.success) push(e, { actor: "you", kind: "resolve", label: "Taken back", text: `${person(p.data.by)} took it back: ${quoted(p.data.note)}` });
        return;
      }
      case "DRAFT_REPLY": {
        const p = DraftRecordedSchema.safeParse(e.payload);
        if (!p.success) return;
        drafts.set(e.seq, p.data.kind);
        push(e, {
          actor: agentActor(p.data.actor), kind: "draft", label: "Drafted reply",
          text: `Drafted a ${REPLY[p.data.kind] ?? "short"} reply for a person to send. It quotes the ledger's facts and promises no second payment.`,
        });
        return;
      }
      case "DRAFT_RESOLVED": {
        const p = DraftResolvedSchema.safeParse(e.payload);
        if (!p.success) return;
        const kind = REPLY[drafts.get(p.data.draftSeq) ?? ""] ?? "drafted";
        push(e, p.data.resolution === "SENT"
          ? { actor: "you", kind: "send", label: "Reply sent", text: `${person(p.data.by)} sent the ${kind} reply to ${input.who}.` }
          : { actor: "you", kind: "resolve", label: "Discarded", text: `${person(p.data.by)} discarded the ${kind} draft.` });
        return;
      }
      case "PAYMENT_REFUSED": {
        const p = RefusedSchema.safeParse(e.payload);
        if (p.success) push(e, { actor: "you", kind: "refused", label: "Refused", tried: "pay it again", text: `${person(p.data.by)} asked to pay again. Policy refused: ${refusal(p.data.message)}.` });
        return;
      }
      case "CARD_REQUESTED": {
        const p = CardRequestedSchema.safeParse(e.payload);
        if (!p.success) return;
        push(e, {
          actor: agentActor(p.data.requestedBy), kind: "act", label: "Asked for card",
          text: `Asked for a single-use Visa card for exactly ${amount}, payable only to ${p.data.merchant.replace(/\.$/, "")}. It cannot pay until a person authorizes it, and it holds the invoice so no transfer can follow.`,
        });
        return;
      }
      case "CARD_DECIDED": {
        const p = CardDecidedSchema.safeParse(e.payload);
        if (!p.success) return;
        push(e, p.data.decision === "APPROVED"
          ? { actor: "you", kind: "sign", label: "Authorized", text: `${person(p.data.by)} authorized the card: ${quoted(p.data.note)} Only a person can; the agent waited for it.` }
          : { actor: "you", kind: "resolve", label: "Declined", text: `${person(p.data.by)} declined the card.` });
        return;
      }
      case "CARD_ISSUED": {
        const p = CardIssuedSchema.safeParse(e.payload);
        if (p.success) push(e, { actor: "airwallex", kind: "act", label: "Card issued", text: `Issued the card${p.data.last4 ? ` (Visa ending ${p.data.last4})` : ""} with the invoice's terms as its controls. Authorized, it is the agent's to pay with.` });
        return;
      }
      case "CARD_CHECKOUT": {
        const p = CardCheckoutPayloadSchema.safeParse(e.payload);
        if (!p.success) return;
        push(e, p.data.status === "APPROVED"
          ? {
              actor: agentActor(p.data.actor), kind: "paid", label: "Paid via TAP",
              text: `Paid ${input.who}'s checkout for ${amount} with the card a person authorized, through Visa TAP.${p.data.tap.verified ? " The merchant verified the agent's signature before it charged." : ""}`,
            }
          : { actor: agentActor(p.data.actor), kind: "refused", label: "Checkout failed", text: `The checkout was ${p.data.status.toLowerCase()}${p.data.reason ? `: ${sentence(p.data.reason)}` : ""}.` });
        return;
      }
      case "CARD_SETTLED": {
        const p = z.looseObject({ matches: z.boolean() }).safeParse(e.payload);
        if (p.success) {
          push(e, p.data.matches
            ? { actor: "visa", kind: "cleared", label: "Cleared", text: "The charge cleared and matched every term the person signed." }
            : { actor: "visa", kind: "refused", label: "Mismatch", text: "The charge cleared but does not match the signed terms. A person must look." });
        }
        return;
      }
      case "INBOX_RECEIVED": {
        const p = InboxSchema.safeParse(e.payload);
        if (p.success) push(e, { actor: "supplier", kind: "message", label: "Wrote again", text: `${p.data.from} wrote again.` });
        return;
      }
      case "CLOSED": {
        const p = ClosedSchema.safeParse(e.payload);
        push(e, { actor: "tessera", kind: "certify", label: "Certified", text: `Reconciled line by line against Airwallex. Certificate ${p.data?.certificateHash?.slice(0, 12) ?? "signed"}.` });
        return;
      }
    }
  });

  // Fold repeats in a row (the same check again on a later run, a test refused seven times) into one step with a count.
  const folded: Array<CaseStep & { tried: string[] }> = [];
  for (const { tried, ...step } of steps) {
    const last = folded.at(-1);
    if (last && last.actor === step.actor && last.kind === step.kind && last.label === step.label) {
      last.count += 1;
      last.at = step.at;
      last.seq = step.seq;
      if (tried && !last.tried.includes(tried)) last.tried.push(tried);
      last.text = step.kind === "refused" ? `Tried ${last.count} moves policy forbids: ${last.tried.join(", ")}. Every one refused.` : step.text;
    } else {
      folded.push({ ...step, count: 1, tried: tried ? [tried] : [] });
    }
  }
  return folded.map(({ tried: _tried, ...step }) => (step.actor === "test" && step.kind === "refused" ? { ...step, text: `Guardrail test. ${step.text}` } : step));
}

/** Where a case stands, from the state of the ledger. */
export function caseOutcome(input: CaseInput, openedSeq: number): CaseOutcome {
  const { obligation, attempts, events, card, evidence, who } = input;
  const amount = formatMinor(obligation.amountMinor, obligation.currency);
  const after = events.filter((e) => e.seq > openedSeq);
  const latest = attempts.at(-1) ?? null;
  const escalated = obligation.status === "ESCALATED";
  const draft = pendingDraft(events);
  const sent = repliesSentSince(events);
  const released = after.some((e) => e.type === "ATTEMPT_INTENT" && IntentSchema.safeParse(e.payload).data?.mode === "HUMAN");
  const landedSince = after.some((e) => e.type === "TRANSFER_STATUS" && TransferStatusPayloadSchema.safeParse(e.payload).data?.to === "PAID");
  const byCard = card !== null && (card.spentMinor > 0 || card.state === "SPENT");
  const cleared = after.some((e) => e.type === "CARD_SETTLED");
  const held = after.some((e) => e.type === "AGENT_DEFERRED");
  const fraud = evidence?.requestsDetailChange === true;
  const leftForYou = draft ? `Send the drafted ${REPLY[draft.kind] ?? ""} reply.`.replace("  ", " ") : escalated ? "Take it back from escalation once you have checked." : null;

  // How it was paid, when it was: the words every paid outcome uses.
  const paidHow = byCard
    ? "Paid once by Visa, via TAP"
    : latest !== null && latest.seq > 1
      ? released ? "Paid once, released in writing" : "Paid once, by the replacement"
      : "Paid once";

  if (obligation.status === "CLOSED") {
    const head = fraud ? "Fraud stopped. Paid once, to the account on file" : sent.PROOF ? "Proof sent. Paid once" : paidHow;
    return { state: "certified", headline: head, detail: "Reconciled against Airwallex and certified.", yours: null };
  }

  if (fraud) {
    const paid = latest?.state === "PAID";
    return escalated
      ? {
          state: "solved", headline: "Fraud stopped",
          detail: `Nothing went to the new account.${paid ? ` ${who} was paid once, at the account on file.` : ""}`,
          yours: `Call ${who} on the number you already hold, then take it back.`,
        }
      : { state: "working", headline: "Holding it for a person", detail: "An email asks to pay a different bank account. Nothing moves to it.", yours: null };
  }

  if (byCard) {
    return {
      state: "solved", headline: paidHow,
      detail: cleared
        ? `${amount}: authorized by a person, paid by the agent through Visa TAP, cleared and proved against the signed terms.`
        : `${amount}: authorized by a person, paid by the agent through Visa TAP. Clearing now.`,
      yours: null,
    };
  }

  if (landedSince && latest?.state === "PAID") {
    const detail = latest.seq > 1
      ? released ? `A person confirmed with ${who} and released it. The original stayed cancelled.` : "Replaced once Airwallex proved the money was back. The original stayed cancelled."
      : `The original landed. Holding was right: a second payment would have paid ${who} twice.`;
    return { state: "solved", headline: paidHow, detail, yours: leftForYou };
  }

  // Paid before the case opened, and the supplier says it never arrived: proof answers it, never a second payment.
  if (latest?.state === "PAID" && evidence?.claimsNonReceipt) {
    if (sent.PROOF) return { state: "solved", headline: "Proof of payment sent", detail: `Airwallex shows it paid. ${who}'s bank traces it now. Not paid twice.`, yours: null };
    if (draft?.kind === "PROOF") return { state: "yours", headline: "Proof ready to send", detail: "Airwallex shows it paid. The reply promises no second payment.", yours: "Send the drafted proof of payment." };
  }

  if (card?.state === "PENDING") {
    return {
      state: "yours", headline: "Authorize the Visa card",
      detail: `Exactly ${amount}, payable only to ${card.merchant.replace(/\.$/, "")}. The agent pays through Visa TAP only once a person signs.`,
      yours: "Authorize the card. The agent pays through Visa TAP once you have.",
    };
  }
  if (card?.state === "ISSUING") return { state: "working", headline: "Authorized; card being issued", detail: "Airwallex is issuing it with the invoice's terms as its controls.", yours: null };
  if (card?.state === "ACTIVE") return { state: "working", headline: "Authorized; the agent pays", detail: "A person signed. The agent pays the checkout through Visa TAP, signed with its own key.", yours: null };

  if (latest?.state === "LIVE" && latest.seq > 1) {
    return {
      state: "working", headline: "Replacement on its way",
      detail: released ? "Released in writing by a person. The original stays cancelled." : "Sent once Airwallex proved the money was back. The original stays cancelled.",
      yours: null,
    };
  }

  if (escalated) {
    const duplicate = latest?.state === "DEAD" && latest.failureCode === "91301";
    const overdue = latest?.state === "LIVE";
    return {
      state: "yours",
      headline: duplicate ? `Confirm with ${who}` : overdue ? "Ask Airwallex to trace it" : "Yours to decide",
      detail: duplicate
        ? `${who} may already hold the money. Only a person can release a second payment, in writing.`
        : obligation.escalationReason ? `${sentence(obligation.escalationReason, 200)}.` : "Policy will not settle this alone.",
      yours: duplicate ? `Confirm with ${who} whether it arrived. Release a second payment in writing only if it didn't.` : "Decide in writing.",
    };
  }

  if (draft) {
    const inFlight = latest?.state === "LIVE";
    return {
      state: "yours", headline: inFlight ? "Held; reply ready" : "Reply ready to send",
      detail: inFlight ? `Still moving, so paying again could pay ${who} twice. The agent drafted a reply.` : "The agent drafted a reply for a person to send.",
      yours: `Send the drafted ${REPLY[draft.kind] ?? ""} reply.`.replace("  ", " "),
    };
  }

  if (latest?.state === "LIVE" && held) {
    return {
      state: "working", headline: "Held: still in transit",
      detail: sent.STATUS ? `${who} has been told it is on its way. Paying again could pay twice.` : `Paying again now could pay ${who} twice.`,
      yours: null,
    };
  }

  return { state: "open", headline: "Unsolved", detail: "Nobody has worked it yet.", yours: null };
}

/** The invoice's case, or null when it never had one (it was not opened with a problem). */
export function caseOf(input: CaseInput): Case | null {
  const opened = input.events.findLast((e) => e.type === "CASE_OPENED");
  if (!opened) return null;
  const brief = CaseOpenedSchema.safeParse(opened.payload);
  if (!brief.success) return null;
  const after = input.events.filter((e) => e.seq > opened.seq);
  return {
    kind: brief.data.kind,
    openedAt: opened.ts,
    openedSeq: opened.seq,
    problem: brief.data.problem,
    steps: caseSteps(after, input),
    outcome: caseOutcome(input, opened.seq),
  };
}
