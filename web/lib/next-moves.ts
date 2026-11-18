import type { IncidentSummary } from "../../src/server/wire";
import { reasonText } from "./agent-verdict";

/**
 * The next move on each invoice, in words a person acts on: who makes it (you, the agent, or nobody yet: the bank has
 * it), a short label for a key or a column, and one sentence for the line beside the button. Read from the board's
 * own summaries (the Commander's decision on the ledger as it stands), so every surface says the same thing.
 */

export type Who = "you" | "agent" | "bank" | "done";

export interface Move {
  item: IncidentSummary;
  who: Who;
  /** A word or two: "Certify", "Decide", "Replace", "With the bank". */
  label: string;
  /** One sentence about the invoice, without its reference (every surface shows that beside it). */
  line: string;
  /** Lower is more urgent. Only moves for you or the agent are ranked. */
  rank: number;
  /** The agent can make this move with its tools (and so a run over it does something). */
  agentCan: boolean;
}

const RANK = { ESCALATED: 0, NEEDS_ACTION: 1, DRAFT: 2, MONEY: 3, SUPPLIER: 4, READ: 5, CERTIFY: 6, HANDOFF: 7, WAIT: 50, DONE: 99 } as const;

/** Only ever called with a non-empty reason; the board trims agent prefixes ("agent:claude: …"). */
const said = (reason: string): string => reasonText(reason).replace(/[.\s]+$/, "");

export function moveOf(item: IncidentSummary, options: { reader?: boolean } = {}): Move {
  const base = { item, agentCan: false };
  if (item.status === "CLOSED") return { ...base, who: "done", label: "Certified", line: "Certified and closed.", rank: RANK.DONE };

  // A person first: nothing the agent does can release an escalation or sign a payment.
  if (item.attention?.kind === "ESCALATED") {
    return { ...base, who: "you", label: "Decide", line: `With you: ${said(item.attention.reason)}.`, rank: RANK.ESCALATED };
  }
  if (item.attention?.kind === "NEEDS_ACTION") {
    // A Visa card for the invoice waits for a signature: only a person can give it.
    if (item.status === "PAYING" && /Visa card/.test(item.attention.reason)) {
      return { ...base, who: "you", label: "Sign card", line: "A single-use Visa card awaits your signature.", rank: RANK.NEEDS_ACTION };
    }
    if (item.next?.action === "PAY_BY_CARD" && item.next.allowed.includes("PAY_BY_CARD")) {
      return { ...base, who: "you", agentCan: true, label: "Pay by card", line: "Returned, and the supplier is waiting. Pay by single-use Visa card.", rank: RANK.NEEDS_ACTION };
    }
    // A failed payment is back in the wallet. Within the automatic limit the replacement needs no signature, so the agent
    // may send it as well as you; otherwise (or when Tessera would rather hand it over) it is yours alone.
    if (item.next?.action === "REPLACE" && item.next.allowed.includes("REPLACE") && item.next.autoReplace) {
      return { ...base, who: "you", agentCan: true, label: "Replace", line: "Failed; the funds are back. Replace it, or let the agent.", rank: RANK.NEEDS_ACTION };
    }
    if (item.next?.action === "FUND") {
      return { ...base, who: "you", agentCan: true, label: "Fund", line: "Failed, and the wallet is short. Fund it, then replace.", rank: RANK.NEEDS_ACTION };
    }
    return { ...base, who: "you", label: "Decide", line: `Your call: ${said(item.attention.reason)}.`, rank: RANK.NEEDS_ACTION };
  }
  if (item.attention?.kind === "DRAFT") {
    return { ...base, who: "you", label: "Send reply", line: "A reply to the supplier is ready for review.", rank: RANK.DRAFT };
  }

  // A supplier message nobody has read can change the decision, so it comes before anything final.
  if ((item.unread ?? 0) > 0) {
    return {
      ...base,
      who: options.reader === false ? "you" : "agent",
      agentCan: options.reader !== false,
      label: "Read message",
      line: "The supplier has written. Read it before anything moves.",
      rank: RANK.READ,
    };
  }

  const next = item.next ?? null;
  const agent = (label: string, line: string, rank: number): Move => ({ ...base, who: "agent", agentCan: true, label, line, rank });
  switch (next?.action) {
    case "REPLACE":
      return next.allowed.includes("REPLACE")
        ? agent("Replace", "Failed; the funds are back. Ready to replace.", RANK.MONEY)
        : { ...base, who: "you", label: "Decide", line: "Failed. Replacing it needs your signature.", rank: RANK.NEEDS_ACTION };
    case "FUND":
      return agent("Fund", "Failed, and the wallet is short. Fund it, then replace.", RANK.MONEY);
    case "PAY_BY_CARD":
      return agent("Pay by card", "Card signed. The agent pays through Visa TAP.", RANK.MONEY);
    case "RECOVER_INTENT":
      return agent("Settle", "Airwallex never answered. Settle it by request ID.", RANK.MONEY);
    case "SEND_PROOF_TO_SUPPLIER":
      return agent("Send proof", "Paid, but the supplier hasn't seen it. Send proof.", RANK.SUPPLIER);
    case "REQUEST_CORRECTION":
      return agent("Ask for details", "Returned on the account details. Ask for corrections.", RANK.SUPPLIER);
    case "SEND_STATUS_TO_SUPPLIER":
      return agent("Update", "The supplier asked for an update.", RANK.SUPPLIER);
    case "CLOSE":
      return next.allowed.includes("CLOSE")
        ? agent("Certify", "Paid and past its hold. Ready to certify.", RANK.CERTIFY)
        : { ...base, who: "bank", label: "Holding", line: "Paid. Holding before it can be certified.", rank: RANK.WAIT };
    case "ESCALATE":
      return agent("Hand off", "Needs a person. The agent will hand it over.", RANK.HANDOFF);
    case "WAIT":
      return {
        ...base,
        who: "bank",
        label: item.latest?.state === "PAID" ? "Holding" : "With the bank",
        line:
          item.latest?.state === "PAID"
            ? "Paid. Holding before it can be certified."
            : "In flight, within its normal window.",
        rank: RANK.WAIT,
      };
    default:
      return { ...base, who: "bank", label: item.latest ? "With the bank" : "Not sent", line: "Nothing to do yet.", rank: RANK.WAIT };
  }
}

/** The moves someone should make now, most urgent first: yours, then the money, the supplier, and certification. */
export function boardMoves(items: IncidentSummary[], options: { reader?: boolean } = {}): Move[] {
  return items
    .map((item) => moveOf(item, options))
    .filter((m) => m.who === "you" || m.who === "agent")
    .sort((a, b) => a.rank - b.rank);
}

/**
 * What "let the agent work the board" will do, said before it starts: the invoices it works (each with its move), and
 * the ones it leaves alone and why. Certified invoices are only counted.
 */
export function agentPlan(items: IncidentSummary[], options: { reader?: boolean } = {}): { work: Move[]; leave: Move[]; certified: number } {
  const moves = items.map((item) => moveOf(item, options));
  return {
    work: moves.filter((m) => m.agentCan).sort((a, b) => a.rank - b.rank),
    leave: moves.filter((m) => !m.agentCan && m.who !== "done").sort((a, b) => a.rank - b.rank),
    certified: moves.filter((m) => m.who === "done").length,
  };
}

/** Why the agent leaves an invoice alone, in a few words. */
export function leftBecause(move: Move): string {
  if (move.who === "you") return "yours to decide";
  if (move.label === "Holding") return "paid, in its hold window";
  if (move.label === "Not sent") return "not sent yet";
  return "with the bank";
}
