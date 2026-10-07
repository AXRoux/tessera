/**
 * Supplier-facing replies, drafted by an agent and sent by a person. Tessera sends nothing itself.
 *
 * The words come from the agent; the facts come from the ledger. A draft is refused if the action is not allowed right
 * now, or if the text carries something a supplier-facing message must never carry: account details, links, an email
 * address, or a promise of another payment.
 */
import { z } from "zod";
import type { LedgerEvent } from "../ledger/ledger";

export const DRAFT_KINDS = ["STATUS", "PROOF", "CORRECTION"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** The Commander action each kind of reply stands for. A draft is allowed only when its action is. */
export const DRAFT_ACTION: Record<DraftKind, "SEND_STATUS_TO_SUPPLIER" | "SEND_PROOF_TO_SUPPLIER" | "REQUEST_CORRECTION"> = {
  STATUS: "SEND_STATUS_TO_SUPPLIER",
  PROOF: "SEND_PROOF_TO_SUPPLIER",
  CORRECTION: "REQUEST_CORRECTION",
};

export const DraftRecordedSchema = z.object({
  actor: z.string(),
  kind: z.enum(DRAFT_KINDS),
  message: z.string(),
  /** Lines written by code from the ledger and Airwallex, never by the agent. */
  facts: z.array(z.string()),
});
export type DraftRecorded = z.infer<typeof DraftRecordedSchema>;

export const DraftResolvedSchema = z.object({ draftSeq: z.number().int(), resolution: z.enum(["SENT", "DISCARDED"]), by: z.string() });

export type PendingDraft = DraftRecorded & { seq: number; at: string };

/** The newest draft that nobody has dealt with yet. A newer draft supersedes an older one. */
export function pendingDraft(events: LedgerEvent[]): PendingDraft | null {
  const resolved = new Set<number>();
  for (const event of events) {
    if (event.type !== "DRAFT_RESOLVED") continue;
    const parsed = DraftResolvedSchema.safeParse(event.payload);
    if (parsed.success) resolved.add(parsed.data.draftSeq);
  }
  for (const event of events.toReversed()) {
    if (event.type !== "DRAFT_REPLY") continue;
    const parsed = DraftRecordedSchema.safeParse(event.payload);
    if (parsed.success) return resolved.has(event.seq) ? null : { ...parsed.data, seq: event.seq, at: event.ts };
  }
  return null;
}

const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;
const RULES: Array<{ test: (text: string) => boolean; reason: string }> = [
  { test: (t) => /\b[A-Z]{2}\d{2}(\s?[A-Z0-9]{4}){3,}/.test(t), reason: "it contains something shaped like an IBAN" },
  {
    test: (t) => /\d{6,}/.test(t.replace(ISO_DATE, "").replace(/[\s-]/g, "")),
    reason: "a long run of digits looks like an account or reference number; the code adds the real references itself",
  },
  { test: (t) => /https?:\/\/|www\./i.test(t), reason: "it contains a link" },
  { test: (t) => /[\w.+-]+@[\w-]+\.[\w.-]+/.test(t), reason: "it contains an email address" },
  {
    test: (t) => /\b(re-?send(ing)?|pay(ing)?\s+(you\s+)?(again|twice)|second\s+(payment|transfer)|another\s+(payment|transfer)|new\s+(payment|transfer)|replacement)\b/i.test(t),
    reason: "a draft may not promise another payment; only the Commander and a person can decide that",
  },
];

/** Null if the text is acceptable; otherwise the reason it is not. */
export function checkDraftText(message: string): string | null {
  const text = message.trim();
  if (text.length < 20) return "the message is too short to be useful";
  if (text.length > 900) return "the message is longer than 900 characters";
  for (const rule of RULES) if (rule.test(text)) return rule.reason;
  return null;
}
