import { actorLabel, actorSubject, reasonText } from "./agent-verdict";
import { money, titleCase } from "./format";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : {};
}

/** Who acted, opening a sentence ("The agent", or the person's address) or inside one ("the agent"). */
const subject = (value: string | null, fallback: string): string => (value ? actorSubject(value) : fallback);
const object = (value: string | null, fallback: string): string => (value ? actorSubject(value).replace(/^The /, "the ") : fallback);

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
/** A minor-unit amount from an event payload, or "?" when the payload does not carry one. */
const amount = (minor: unknown, currency: unknown): string => (typeof minor === "number" && typeof currency === "string" ? money(minor, currency) : "?");

/** Free text from a person or an agent often ends in its own full stop; sentences here add theirs. */
const bare = (value: string | null): string | null => (value === null ? null : value.replace(/[.\s]+$/, ""));

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
/** Refusal messages carry the incident's internal id; the page is already about that incident. */
const withoutIds = (value: string | null): string | null => (value === null ? null : value.replace(/obligation\s+/gi, "").replace(UUID, "").replace(/\s{2,}/g, " ").replace(/^\s*:\s*/, ""));

const APPROVER_KIND: Record<string, string> = { HUMAN: "a person", POLICY: "policy" };

/** Commander actions as an operator says them, for sentences about a decision changing. */
export const ACTION_WORDS: Record<string, string> = {
  NONE: "nothing to do",
  WAIT: "wait",
  RECOVER_INTENT: "resolve the open request",
  SEND_STATUS_TO_SUPPLIER: "update the supplier",
  SEND_PROOF_TO_SUPPLIER: "send proof of payment",
  REQUEST_CORRECTION: "ask for corrected details",
  REPLACE: "replace the payment",
  FUND: "fund the replacement",
  PAY_BY_CARD: "pay it by Visa card",
  CLOSE: "close the incident",
  ESCALATE: "hand to a person",
};
const action = (value: unknown): string => ACTION_WORDS[text(value) ?? ""] ?? text(value) ?? "unknown";

/** What re-reading the transfer showed after a webhook, keyed by the receipt's `outcome`. */
const WEBHOOK_OUTCOME: Record<string, string> = {
  applied: "it had moved, and the ledger recorded the new status",
  no_change: "the ledger already had that status",
  out_of_order: "a newer event was already taken, so this one was old news",
  unknown_transfer: "the transfer is not one Tessera sent",
  mismatch_escalated: "Airwallex's transfer did not match the ledger, so the incident went to a person",
  not_a_transfer: "it is not about a transfer, so it was only recorded",
  recorded: "it was recorded",
};

const WAKE_WORDS: Record<string, string> = {
  requested: "An agent was asked to look.",
  not_needed: "No agent was needed.",
  off: "Waking an agent is switched off.",
  suppressed: "No agent was woken, because the incident is closed or with a person.",
};

/** What each tool call did, said of the agent in the past tense; and what it would have done, for a refusal. */
const TOOL_DONE: Record<string, string> = {
  list_incidents: "read the board",
  assess_incident: "asked what the policy allows here",
  read_supplier_message: "read the supplier's message",
  replace_payment: "replaced the payment",
  fund_replacement: "funded the replacement",
  pay_invoice_by_card: "worked the invoice's Visa card",
  draft_supplier_reply: "drafted a reply for a person to send",
  defer_incident: "chose to wait",
  escalate_to_human: "handed the incident to a person",
  reconcile_and_close: "reconciled and certified the payment",
  verify_ledger: "checked that the history is intact",
};
const TOOL_TRIED: Record<string, string> = {
  replace_payment: "replace the payment",
  fund_replacement: "fund the replacement",
  pay_invoice_by_card: "pay the invoice by Visa card",
  reconcile_and_close: "certify the payment",
  escalate_to_human: "hand the incident over",
  draft_supplier_reply: "draft a reply",
  defer_incident: "defer",
  read_supplier_message: "read the supplier's message",
  assess_incident: "assess the incident",
};

/** A short title per event type, for the history's left column. Unknown types are title-cased rather than hidden. */
const TITLES: Record<string, string> = {
  OBLIGATION_CREATED: "Invoice recorded",
  ATTEMPT_INTENT: "Intent sealed",
  ATTEMPT_RESOLVED: "Lock released",
  ATTEMPT_ABANDONED: "Never sent",
  TRANSFER_STATUS: "Airwallex",
  LATE_FAILURE: "Late return",
  CREATE_AMBIGUOUS: "Unclear answer",
  TRANSFER_MISMATCH: "Mismatch",
  STATUS_AFTER_DEAD: "Late status",
  UNKNOWN_STATUS: "Unknown status",
  ESCALATED: "Handed over",
  ESCALATION_RESOLVED: "Taken back",
  EVIDENCE_RECORDED: "Evidence",
  AGENT_TOOL_CALL: "Agent",
  DRAFT_REPLY: "Draft written",
  DRAFT_RESOLVED: "Draft settled",
  AGENT_DEFERRED: "Agent waited",
  CLOSED: "Certified",
  INTENT_STALE: "Stale intent",
  CERTIFICATE_REVOKED: "Revoked",
  INBOX_RECEIVED: "Mail arrived",
  REQUEST_RECEIVED: "Invoice received",
  REQUEST_APPROVED: "Approved",
  REQUEST_DECLINED: "Declined",
  STORY_STEP: "Sandbox",
  CASE_OPENED: "Issue opened",
  INVESTIGATED: "Investigated",
  PAYMENT_REFUSED: "Refused",
  WEBHOOK_RECEIVED: "Webhook",
  INCIDENT_REACTION: "Reassessed",
  AGENT_WAKE: "Agent woken",
  AGENT_WAKE_FINISHED: "Agent done",
  FUNDING_INTENT: "Conversion sealed",
  FUNDING_STATUS: "Conversion",
  FUNDING_AMBIGUOUS: "Unclear answer",
  FUNDING_ABANDONED: "Never booked",
  FUNDING_MISMATCH: "Mismatch",
  FUNDING_AFTER_ABANDON: "Late conversion",
  FUNDING_BALANCES: "Balances",
  FUNDING_QUOTED: "Quote",
  FUNDING_REPLANNED: "Replanned",
  CHAIN_REBASELINED: "Rebaselined",
  CARD_REQUESTED: "Card asked for",
  CARD_REFUSED: "Card refused",
  CARD_DECIDED: "Card signed",
  CARD_ISSUE_INTENT: "Card sealed",
  CARD_ISSUED: "Card issued",
  CARD_ISSUE_FAILED: "Card failed",
  CARD_CHECKOUT: "Visa TAP",
  CARD_CHARGE: "Card charge",
  CARD_SETTLED: "Card proved",
  CARD_STATUS: "Card",
};

export function eventTitle(type: string): string {
  return TITLES[type] ?? titleCase(type);
}

/** One plain sentence per ledger event type. Unknown types fall back to their name, so nothing is ever hidden. */
export function describeEvent(type: string, payload: unknown): string {
  const p = record(payload);
  switch (type) {
    case "OBLIGATION_CREATED":
      return "The invoice entered the ledger. From here, every move it makes is written down.";
    case "ATTEMPT_INTENT": {
      const note = text(p.note);
      const kind = APPROVER_KIND[text(p.mode) ?? ""] ?? "unknown";
      return `Attempt ${String(p.seq)} was sealed in the ledger before a cent moved, approved by ${text(p.approver) ?? "unknown"} (${kind})${note ? `: “${note}”` : "."}`;
    }
    case "TRANSFER_STATUS": {
      const from = text(p.from);
      const code = text(p.failureCode);
      const move = from ? `moved the transfer from ${from} to ${text(p.to) ?? "an unknown state"}` : `accepted the transfer as ${text(p.to) ?? "new"}`;
      return `Airwallex ${move}${code ? `, with failure code ${code}` : ""}.`;
    }
    case "LATE_FAILURE":
      return `A transfer reported as paid was returned afterwards (code ${text(p.failureCode) ?? "unknown"}). The incident reopened.`;
    case "CREATE_AMBIGUOUS":
      return "The request to Airwallex timed out without a clear answer. Tessera looks it up by its original request ID rather than sending a new one.";
    case "TRANSFER_MISMATCH":
      return text(p.detail) ?? "Airwallex returned a transfer that does not match the ledger. It was held for a person.";
    case "ATTEMPT_ABANDONED":
      return `Airwallex rejected the request outright, so nothing was sent: ${text(p.reason) ?? "no reason given"}.`;
    case "STATUS_AFTER_DEAD":
      return `Airwallex reported ${text(p.status) ?? "a new status"} after the transfer was cancelled. Ignored, because the payment was already released.`;
    case "UNKNOWN_STATUS":
      return `Airwallex reported a status Tessera does not recognize (${text(p.status) ?? "unknown"}). The payment stays locked until a person looks.`;
    case "ESCALATED":
      return `Handed to a person: ${bare(reasonText(text(p.reason) ?? "")) || "no reason recorded"}.`;
    case "EVIDENCE_RECORDED": {
      const evidence = record(p.evidence);
      const by = object(text(p.enteredBy), "an operator");
      const who = text(p.source) === "model" ? `read by the reader model, called by ${by}` : `entered by hand by ${by}`;
      return `Supplier evidence ${who}: ${text(evidence.summary) ?? "no summary"}`;
    }
    case "AGENT_TOOL_CALL": {
      const who = actorSubject(text(p.actor) ?? "agent:agent");
      const raw = text(p.tool) ?? "a tool";
      const outcome = text(p.outcome);
      if (outcome === "ok") return `${who} ${TOOL_DONE[raw] ?? `used “${raw.replaceAll("_", " ")}”`}.`;
      const detail = bare(withoutIds(text(p.detail)));
      return `${who} tried to ${TOOL_TRIED[raw] ?? raw.replaceAll("_", " ")}, and policy ${outcome === "refused" ? "refused" : "turned it away"}${detail ? `: ${detail}.` : "."}`;
    }
    case "DRAFT_REPLY":
      return `${subject(text(p.actor), "The agent")} drafted a ${(text(p.kind) ?? "reply").toLowerCase()} reply for the supplier. Nothing was sent; a person decides.`;
    case "DRAFT_RESOLVED":
      return text(p.resolution) === "SENT"
        ? `${subject(text(p.by), "A person")} sent the drafted reply to the supplier.`
        : `${subject(text(p.by), "A person")} discarded the drafted reply.`;
    case "AGENT_DEFERRED":
      return `${subject(text(p.actor), "The agent")} chose to wait: ${bare(text(p.note)) ?? "no reason recorded"}.`;
    case "CLOSED":
      return "Every line matched against Airwallex. Certified, and sealed.";
    case "ESCALATION_RESOLVED":
      return `${subject(text(p.by), "A person")} took the incident back from escalation: "${bare(text(p.note)) ?? "no note"}".`;
    case "ATTEMPT_RESOLVED":
      return `${subject(text(p.by), "A person")} released the payment lock after checking Airwallex (${text(p.from) ?? "?"} to ${text(p.to) ?? "?"}): "${bare(text(p.note)) ?? "no note"}".`;
    case "INTENT_STALE":
      return `An attempt has waited ${String(p.ageHours ?? "?")}h without a transfer at Airwallex. Its lock stays until a person releases it.`;
    case "CERTIFICATE_REVOKED":
      return `The certificate was revoked: ${bare(text(p.reason)) ?? "no reason recorded"}.`;
    case "REQUEST_RECEIVED": {
      const verdict = text(p.verdict);
      const what = `${text(p.reference) ?? "An invoice"} for ${amount(p.amountMinor, p.currency)} arrived from ${text(p.from) ?? "a supplier"}`;
      if (verdict === "DUPLICATE") return `${what} again. Filed with this invoice rather than paid again.`;
      if (verdict === "HELD") return `${what}. It failed verification and was put on hold; nothing was opened or paid.`;
      return `${what}. Verified on receipt.`;
    }
    case "REQUEST_APPROVED":
      return `Approved by ${object(text(p.by), "a person")}: “${bare(text(p.note)) ?? "no note"}”.`;
    case "REQUEST_DECLINED":
      return `Declined by ${object(text(p.by), "a person")}: “${bare(text(p.note)) ?? "no note"}”.`;
    case "INVESTIGATED": {
      const checks = Array.isArray(p.checks) ? p.checks.map(record) : [];
      const flags = checks.filter((c) => c.ok === false).map((c) => text(c.label)).filter((l): l is string => l !== null);
      return `${text(p.label) ?? "Investigated"}, checked against the vendor record and the ledger${flags.length > 0 ? `: ${flags.join("; ")}` : ""}.`;
    }
    case "CASE_OPENED": {
      const problem = record(p.problem);
      return `Supplier issue opened: ${bare(text(problem.headline)) ?? "a payment needs attention"}. ${text(problem.detail) ?? ""}`.trimEnd();
    }
    case "STORY_STEP":
      if (text(p.step) === "lands") return "The delayed transfer landed at Airwallex. Tessera read it back before anything else moved.";
      return text(p.actor) === "bank"
        ? `Airwallex sandbox update${text(p.failureType) ? `: ${titleCase(text(p.failureType)!)}` : ""}, run by ${text(p.by) ?? "the operator"}. Tessera read the result back from Airwallex.`
        : `Supplier email received on the sandbox, run by ${text(p.by) ?? "the operator"}.`;
    case "INBOX_RECEIVED":
      return `A message from ${text(p.from) ?? "the supplier"} arrived in the inbox (${String(p.chars ?? "?")} characters). Only its fingerprint is in the ledger.`;
    case "PAYMENT_REFUSED":
      return `A payment requested by ${object(text(p.by), "someone")} was refused by policy${text(p.message) ? `: ${bare(withoutIds(text(p.message)))}` : ""}.`;
    case "WEBHOOK_RECEIVED": {
      const claimed = text(p.claimedStatus);
      const outcome = WEBHOOK_OUTCOME[text(p.outcome) ?? ""] ?? "it was recorded";
      return `Airwallex sent ${text(p.name) ?? "an event"}${claimed ? ` saying ${claimed}` : ""}. Signature checked. Tessera re-read the transfer instead of trusting the message: ${outcome}.`;
    }
    case "INCIDENT_REACTION": {
      const trigger = record(p.trigger);
      const before = record(p.before);
      const after = record(p.after);
      // Assessed as it was opened: history, not news, so nothing is woken for it.
      if (text(trigger.source) === "setup") return `Assessed as it was opened: the decision is "${action(after.recommended)}".`;
      const cause = text(trigger.source) === "webhook" ? `Airwallex's ${text(trigger.eventName) ?? "webhook"}` : "The background sweep";
      const change = before.recommended !== after.recommended
        ? `changed the decision from "${action(before.recommended)}" to "${action(after.recommended)}"`
        : `${p.decisionChanged === true ? "changed what may be done; the decision stays" : "left the decision"} at "${action(after.recommended)}"`;
      return `${cause} ${change}. ${WAKE_WORDS[text(p.wake) ?? ""] ?? ""}`.trimEnd();
    }
    case "AGENT_WAKE": {
      const names = Array.isArray(p.eventNames) ? p.eventNames.filter((n): n is string => typeof n === "string") : [];
      const cause = names.length > 0 ? names.join(" and ") : "a bank-side change";
      const who = subject(text(p.actor), "The agent");
      if (text(p.outcome) === "started") return `${who} was woken by ${cause} to work this incident only.`;
      return `${who} was not woken for ${cause} (${text(p.outcome) ?? "skipped"}): ${bare(text(p.detail)) ?? "no reason recorded"}.`;
    }
    case "AGENT_WAKE_FINISHED": {
      const calls = typeof p.calls === "number" ? p.calls : 0;
      const refused = typeof p.refused === "number" ? p.refused : 0;
      const why = text(p.stoppedBecause) === "finished" ? "finished" : `stopped (${(text(p.stoppedBecause) ?? "unknown").replaceAll("_", " ")})`;
      const report = bare(text(p.report));
      return `The woken run ${why} after ${calls} tool call${calls === 1 ? "" : "s"}${refused > 0 ? `, ${refused} refused by policy` : ""}${report ? `. Its report: "${report}".` : "."}`;
    }
    case "FUNDING_INTENT": {
      const t = record(p.terms);
      const note = text(p.note);
      return `A conversion was recorded before any money moved: buy ${amount(t.buyMinor, t.buyCurrency)} for ${amount(t.sellMinor, t.sellCurrency)} at ${String(t.rate ?? "?")} ${text(t.currencyPair) ?? ""}. Approved by ${text(p.approver) ?? "unknown"} (${APPROVER_KIND[text(p.mode) ?? ""] ?? "unknown"})${note ? `: "${note}"` : "."}`;
    }
    case "FUNDING_STATUS":
      return `Airwallex ${text(p.from) ? `moved conversion ${text(p.conversionId) ?? ""} from ${text(p.from)} to` : `booked conversion ${text(p.conversionId) ?? ""} as`} ${text(p.to) ?? "an unknown state"}.`;
    case "FUNDING_AMBIGUOUS":
      return "The conversion request timed out without a clear answer. Tessera looks it up by its original request ID rather than sending a new one.";
    case "FUNDING_ABANDONED":
      return `The conversion was never booked, so nothing moved: ${bare(text(p.reason)) ?? "no reason given"}.`;
    case "FUNDING_MISMATCH":
      return text(p.detail) ?? "Airwallex returned a conversion that does not match the ledger. It was held for a person.";
    case "FUNDING_AFTER_ABANDON":
      return `Airwallex holds conversion ${text(p.conversionId) ?? "?"} (${text(p.status) ?? "?"}) for a request Tessera had released as never booked. Held for a person.`;
    case "FUNDING_BALANCES": {
      const wallets = Object.entries(record(p.wallets)).flatMap(([currency, minor]) => (typeof minor === "number" ? [money(minor, currency)] : []));
      return `Wallets read again after the conversion settled: ${wallets.join(", ") || "unknown"}.`;
    }
    case "FUNDING_QUOTED": {
      const q = record(p.quote);
      return `A quote was fetched for a person to review: ${amount(q.buyMinor, q.buyCurrency)} for ${amount(q.sellMinor, q.sellCurrency)}, valid until ${text(q.validTo) ?? "?"}.`;
    }
    case "FUNDING_REPLANNED":
      return `A quote was thrown away and the conversion planned again: ${bare(text(p.reason)) ?? "no reason given"}.`;
    case "CARD_REQUESTED":
      return `${actorSubject(text(p.requestedBy) ?? "someone")} asked for a single-use Visa card for exactly ${amount(p.amountMinor, p.currency)}, payable only to ${bare(text(p.merchant)) ?? "the supplier"}. It takes the invoice's lock: no transfer while it holds. A person must sign it.`;
    case "CARD_REFUSED": {
      const reasons = Array.isArray(p.reasons) ? p.reasons.filter((r): r is string => typeof r === "string") : [];
      return `The card policy refused the card: ${bare(reasons.join("; ")) || "no reason given"}.`;
    }
    case "CARD_DECIDED":
      return text(p.decision) === "APPROVED"
        ? `${subject(text(p.by), "A person")} signed the card: "${bare(text(p.note)) ?? "no note"}".`
        : `${subject(text(p.by), "A person")} declined the card, releasing the invoice: "${bare(text(p.note)) ?? "no note"}".`;
    case "CARD_ISSUE_INTENT":
      return "The card's issue was sealed in the ledger before Airwallex was asked to cut it.";
    case "CARD_ISSUED":
      return `Airwallex issued the card${text(p.last4) ? ` ending ${text(p.last4)}` : ""}, with the signed terms as its own controls.`;
    case "CARD_ISSUE_FAILED":
      return `Airwallex would not issue the card: ${bare(text(p.message)) ?? "no reason given"}.`;
    case "CARD_CHECKOUT": {
      const tap = record(p.tap);
      const verdict = tap.verified === true ? "verified the agent's Visa Trusted Agent Protocol signature" : `rejected the agent's signature (${bare(text(tap.reason)) ?? "no reason"})`;
      const status = text(p.status);
      return `${actorSubject(text(p.actor) ?? "agent:agent")} paid at the supplier's checkout${text(p.invoice) ? ` for ${text(p.invoice)}` : ""}. The merchant ${verdict}${status === "APPROVED" ? `, and the charge went through (order ${text(p.orderId) ?? "?"}).` : status === "DECLINED" ? `, but the card declined: ${bare(text(p.reason)) ?? "no reason"}.` : "."}`;
    }
    case "CARD_CHARGE":
      return `Airwallex reported a card ${(text(p.type) ?? "charge").toLowerCase()} of ${amount(p.amountMinor, p.currency)} at ${text(p.merchant) ?? "an unnamed merchant"}: ${(text(p.status) ?? "unknown").toLowerCase()}${text(p.failureReason) ? ` (${text(p.failureReason)})` : ""}.`;
    case "CARD_SETTLED":
      return p.matches === true
        ? `The card charge of ${amount(p.amountMinor, p.currency)} was proved against every signed term: merchant, cap, category, currency, single use, a person's signature.`
        : `The card charge of ${amount(p.amountMinor, p.currency)} does NOT match what was signed. A person must look.`;
    case "CARD_STATUS":
      return `The card is now ${(text(p.to) ?? "changed").toLowerCase()}: ${bare(text(p.why)) ?? "no reason recorded"}.`;
    default:
      return type;
  }
}
