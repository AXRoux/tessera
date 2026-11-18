/**
 * What happens after a person approves a supplier's invoice, told as a story the console can play one step at a time.
 *
 * Three kinds of step:
 *   - the supplier's and the bank's parts ("play"), which this module performs: a message filed in the invoice's inbox,
 *     or a transfer moved through Airwallex's sandbox simulator (the offline fake when there are no keys). Each one is
 *     chained as STORY_STEP, so the ledger says plainly that the bank's part was played, by whom, and when;
 *   - a person's moves ("action"), which the console sends to the ordinary routes (replace, close) and which policy
 *     answers exactly as it would without a story; and
 *   - where it ends ("yours"): what still needs a person when the money is settled.
 *
 * Whether a step is done is read from the ledger every time (attempts, refusals, the certificate, chained story steps),
 * never stored, so the story cannot drift from what actually happened.
 */
import { z } from "zod";
import type { Attempt, LedgerEvent, Obligation } from "../ledger/ledger";
import { formatMinor } from "../money";
import { fill, type Supplier, type StoryId, dueDate } from "./suppliers";

export type StoryActor = "supplier" | "bank" | "you";
export type StoryAction = "replace" | "retry" | "certify" | "card-sign" | "card-pay";
export type StoryEffect =
  | { kind: "message"; followUp: true }
  | { kind: "resend" }
  | { kind: "fail"; failureType: string }
  | { kind: "pay" };

interface StepDef {
  id: string;
  actor: StoryActor;
  title: string;
  /** What Tessera made of it, shown once the step is done. */
  after?: string;
  play?: StoryEffect;
  action?: StoryAction;
  /** A closing note: never "done", it is what is left for a person. */
  yours?: boolean;
  /** The replace step also offers the card rail: a single-use Visa card, paid by the agent through Visa TAP. */
  alt?: "card";
  done?: (s: StoryState) => boolean;
}

export interface StoryState {
  obligation: Obligation;
  attempts: Attempt[];
  events: LedgerEvent[];
  hasCard: boolean;
  /** The invoice's Visa card, if it has one: its state, what it charged, and whether the charge is proved. */
  card: { state: string; spentMinor: number; settled: boolean } | null;
}

export interface StoryStep {
  id: string;
  actor: StoryActor;
  title: string;
  after: string | null;
  state: "done" | "next" | "later" | "yours";
  play: boolean;
  action: StoryAction | null;
  alt: "card" | null;
}

const StoryStepPayload = z.looseObject({ step: z.string() });

/** The story steps already played on this invoice, by id, with the seq of the event that recorded each. */
export function playedSteps(events: LedgerEvent[]): Map<string, number> {
  const played = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "STORY_STEP") continue;
    const p = StoryStepPayload.safeParse(e.payload);
    if (p.success) played.set(p.data.step, e.seq);
  }
  return played;
}

/** A refused payment request (PAYMENT_REFUSED) written after `afterSeq`. */
const refusedAfter = (events: LedgerEvent[], afterSeq: number): boolean => events.some((e) => e.type === "PAYMENT_REFUSED" && e.seq > afterSeq);
const lastSeqOf = (events: LedgerEvent[], type: string): number => events.findLast((e) => e.type === type)?.seq ?? 0;

function definitions(supplier: Supplier, story: StoryId, o: Obligation, st: StoryState): StepDef[] {
  const amount = formatMinor(o.amountMinor, o.currency);
  const who = supplier.name;
  const head: StepDef[] = [
    { id: "sent", actor: "supplier", title: `Invoice ${o.reference} received, ${amount}`, after: "Verified on receipt against the vendor record.", done: () => true },
    {
      id: "approved", actor: "you", title: `Approved; transfer sent to ${supplier.legalName}`,
      after: "Recorded in the ledger before any money moved. Airwallex accepted the transfer.",
      done: (s) => s.attempts.length > 0,
    },
  ];
  const retryDone = (step: string) => (s: StoryState) => {
    const anchor = Math.max(lastSeqOf(s.events, "ATTEMPT_INTENT"), playedSteps(s.events).get(step) ?? 0);
    return refusedAfter(s.events, anchor);
  };
  const latestPaid = (s: StoryState) => s.obligation.status === "CLOSED" || s.attempts.at(-1)?.state === "PAID";
  const certify: StepDef = {
    id: "certify", actor: "you", title: "Reconcile and certify", action: "certify",
    after: "Matched line by line against Airwallex. Certificate signed.",
    done: (s) => s.obligation.status === "CLOSED",
  };

  switch (story) {
    case "timeout": {
      const failed: StepDef[] = [
        ...head,
        { id: "chase", actor: "supplier", title: `${who} follows up: payment hasn't arrived`, play: { kind: "message", followUp: true },
          after: "Tessera holds. The transfer is still inside its settlement window, so sending again could pay twice." },
        { id: "fail", actor: "bank", title: "Airwallex: transfer failed, channel timeout (91402)", play: { kind: "fail", failureType: "CHANNEL_TIMEOUT" },
          after: "Confirmed with Airwallex, not taken from a message: cancelled, funds back in the wallet. Paying again is now allowed.",
          done: (s) => s.attempts.length > 1 || s.attempts[0]?.state === "DEAD" },
      ];
      if (st.card) {
        // Paid again by single-use Visa card: a person signs it, the agent pays the supplier's checkout through Visa TAP.
        const cardAnchor = (s: StoryState) => Math.max(lastSeqOf(s.events, "CARD_CHECKOUT"), lastSeqOf(s.events, "ATTEMPT_INTENT"));
        return [
          ...failed,
          { id: "replace", actor: "you", title: "Pay by single-use Visa card", action: "replace", alt: "card",
            after: `One card for exactly ${amount}, payable only to ${supplier.legalName}. It holds the invoice's lock, so no transfer can follow it.`,
            done: () => true },
          { id: "card-sign", actor: "you", title: "Sign the card", action: "card-sign",
            after: "Signed in writing. Airwallex issued the card with the invoice's terms as its controls.",
            done: (s) => s.card !== null && s.card.state !== "PENDING" },
          { id: "card-pay", actor: "you", title: `Agent pays ${who}'s checkout through Visa TAP`, action: "card-pay",
            after: "The checkout verified the agent's signature before it charged the exact amount.",
            done: (s) => (s.card?.spentMinor ?? 0) > 0 || s.card?.state === "SPENT" },
          { id: "card-clear", actor: "bank", title: "Visa: charge cleared and proved against the signed terms",
            done: (s) => s.card?.settled === true || s.obligation.status === "CLOSED" },
          { id: "retry", actor: "you", title: "Send a transfer as well", action: "retry",
            after: "Declined by policy and logged. The card holds this invoice; a transfer could pay twice.",
            done: (s) => refusedAfter(s.events, cardAnchor(s)) },
          certify,
          { id: "yours", actor: "you", title: `Reply to ${who} with the payment details.`, yours: true },
        ];
      }
      return [
        ...failed,
        { id: "replace", actor: "you", title: "Send a replacement", action: "replace", alt: "card",
          after: "New transfer under a fresh request ID. The original stays cancelled.",
          done: (s) => s.attempts.length > 1 || s.hasCard },
        { id: "retry", actor: "you", title: "Send it again", action: "retry",
          after: "Declined by policy and logged. One open payment per invoice.", done: retryDone("replace") },
        { id: "pay", actor: "bank", title: "Airwallex: replacement paid", play: { kind: "pay" }, done: latestPaid },
        certify,
        { id: "yours", actor: "you", title: `Reply to ${who} with the payment details.`, yours: true },
      ];
    }
    case "inflight":
      return [
        ...head,
        { id: "chase", actor: "supplier", title: `${who} asks for the payment to be sent again`, play: { kind: "message", followUp: true },
          after: "Tessera holds. The original transfer is still in flight." },
        { id: "retry", actor: "you", title: "Send it again", action: "retry",
          after: "Declined by policy and logged. The original is still in flight.", done: retryDone("chase") },
        { id: "pay", actor: "bank", title: "Airwallex: transfer paid", play: { kind: "pay" }, done: latestPaid,
          after: "The original landed. Paid once." },
        certify,
        { id: "yours", actor: "you", title: `Let ${who} know the payment has landed.`, yours: true },
      ];
    case "returned":
      return [
        ...head,
        { id: "fail", actor: "bank", title: "Airwallex: transfer returned, duplication (91301)", play: { kind: "fail", failureType: "DUPLICATION_RETURN" },
          after: `${who} may already hold the funds. Replacement blocked and assigned to you.`,
          done: (s) => s.attempts[0]?.state === "DEAD" },
        { id: "retry", actor: "you", title: "Send a replacement", action: "retry",
          after: "Declined by policy and logged. A second payment needs a named approver, in writing.", done: retryDone("fail") },
        { id: "yours", actor: "you", title: `Confirm with ${who} whether the first payment arrived before releasing another.`, yours: true },
      ];
    case "reminder":
      return [
        ...head,
        { id: "resend", actor: "supplier", title: `${who} sends a second notice for ${o.reference}`, play: { kind: "resend" },
          after: "Matched to the open invoice and filed with it. Not paid again." },
        { id: "pay", actor: "bank", title: "Airwallex: transfer paid", play: { kind: "pay" }, done: latestPaid },
        certify,
      ];
    case "missing":
      return [
        ...head,
        { id: "pay", actor: "bank", title: "Airwallex: transfer paid", play: { kind: "pay" }, done: latestPaid },
        { id: "chase", actor: "supplier", title: `${who}: the payment isn't on their statement`, play: { kind: "message", followUp: true },
          after: "Airwallex shows it paid, so a second payment is blocked. Next: proof of payment." },
        { id: "retry", actor: "you", title: "Send it again", action: "retry",
          after: "Declined by policy and logged. The money has already left.", done: retryDone("chase") },
        { id: "yours", actor: "you", title: `Send ${who} proof of payment and ask their bank to trace it.`, yours: true },
      ];
    case "impostor":
      return head.slice(0, 1);
  }
}

/** The story of one invoice as it stands: every step, which are done, and the one to play or press next. */
export function storySteps(supplier: Supplier, story: StoryId, s: StoryState): StoryStep[] {
  const played = playedSteps(s.events);
  let nextGiven = false;
  return definitions(supplier, story, s.obligation, s).map((d) => {
    // A played step is done the moment it is chained, even if the bank is still catching up (a FAILED transfer that
    // Airwallex has not cancelled yet), so it is never offered twice.
    const done = !d.yours && ((d.play !== undefined && played.has(d.id)) || (d.done ? d.done(s) : false));
    let state: StoryStep["state"];
    if (d.yours) state = nextGiven ? "later" : "yours";
    else if (done) state = "done";
    else if (!nextGiven) state = "next";
    else state = "later";
    if (state === "next") nextGiven = true;
    return { id: d.id, actor: d.actor, title: d.title, after: d.after ?? null, state, play: d.play !== undefined, action: d.action ?? null, alt: d.alt ?? null };
  });
}

/** The effect of the step to play now, or why it cannot be played. */
export function effectFor(supplier: Supplier, story: StoryId, s: StoryState, stepId: string): StoryEffect | string {
  const steps = storySteps(supplier, story, s);
  const step = steps.find((x) => x.id === stepId);
  if (!step) return `this story has no step "${stepId}"`;
  if (step.state !== "next") return step.state === "done" ? "that step has already happened" : "that step is not next";
  const def = definitions(supplier, story, s.obligation, s).find((d) => d.id === stepId);
  if (!def?.play) return "that step is a person's move, not the supplier's or the bank's";
  return def.play;
}

/** The supplier's follow-up as it arrives, filled in for this invoice. */
export function followUpFor(supplier: Supplier, o: Obligation, receivedAt: Date): { from: string; email: string; statementText?: string } | null {
  const f = supplier.followUp;
  if (!f) return null;
  const values = { ref: o.reference, amount: formatMinor(o.amountMinor, o.currency), due: dueDate(receivedAt, supplier.dueInDays) };
  return { from: f.from, email: `Subject: ${fill(f.subject, values)}\n\n${fill(f.body, values)}`, ...(f.statementText ? { statementText: f.statementText } : {}) };
}
