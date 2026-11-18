/**
 * The door every supplier request comes through, before any invoice exists. Code only: no model decides whether a
 * request may become a payment.
 *
 * What the request may set: which invoice it is and how much it asks for, and both are checked against the text.
 * What it can never set: who gets paid. The payee is the Airwallex beneficiary on the vendor record, whatever the
 * email says. An email that tries to move the money elsewhere, comes from a domain the vendor record does not trust,
 * or talks to an assistant is held for a person; an invoice already on the ledger is never opened a second time.
 */
import { DETAIL_CHANGE, EMBEDDED_INSTRUCTION, mentionsAmount } from "./evidence";
import { formatMinor } from "../money";

export type IntakeVerdict = "PAYABLE" | "HELD" | "DUPLICATE";

export interface IntakeCheck {
  id: "sender" | "payee" | "instructions" | "amount" | "limit" | "reference";
  ok: boolean;
  label: string;
  detail: string;
}

export interface IntakeRequest {
  sender: string;
  subject: string;
  body: string;
  reference: string;
  amountMinor: number;
  currency: string;
}

export interface VendorRecord {
  name: string;
  legalName: string;
  /** The only domain billing mail is trusted from. */
  domain: string;
}

export interface IntakeContext {
  vendor: VendorRecord;
  /** The invoice already on the ledger under this reference, if any. */
  existing: { id: string; status: string } | null;
  /** Largest payout this account makes, in minor units. */
  maxAmountMinor: number;
}

export interface IntakeResult {
  verdict: IntakeVerdict;
  checks: IntakeCheck[];
  /** One sentence for the person: why it may be paid, or why not. */
  summary: string;
}

/** The address's domain, lower-cased; "" when there is none. */
export const domainOf = (address: string): string => address.trim().toLowerCase().match(/@([a-z0-9.-]+)$/)?.[1] ?? "";

export function checkIntake(request: IntakeRequest, ctx: IntakeContext): IntakeResult {
  const text = `${request.subject}\n${request.body}`;
  const amount = formatMinor(request.amountMinor, request.currency);
  const domain = domainOf(request.sender);
  const trusted = domain === ctx.vendor.domain || domain.endsWith(`.${ctx.vendor.domain}`);
  const changesBank = DETAIL_CHANGE.test(text);
  const instructs = EMBEDDED_INSTRUCTION.test(text);
  const states = mentionsAmount(text, request.amountMinor, request.currency) && text.includes(request.reference);
  const withinLimit = request.amountMinor > 0 && request.amountMinor <= ctx.maxAmountMinor;

  const checks: IntakeCheck[] = [
    trusted
      ? { id: "sender", ok: true, label: "Sender on file", detail: `${request.sender} is ${ctx.vendor.name}'s billing domain on the vendor record.` }
      : { id: "sender", ok: false, label: "Sender not on file", detail: `${ctx.vendor.name} bills from ${ctx.vendor.domain}. This came from ${domain || "an unknown address"}.` },
    changesBank
      ? { id: "payee", ok: false, label: "Asks to change bank details", detail: `The email gives other bank details. Tessera only ever pays ${ctx.vendor.legalName} at the account on file; confirm any change on a number you already hold.` }
      : { id: "payee", ok: true, label: "Pays the account on file", detail: `Payment goes to ${ctx.vendor.legalName} at the Airwallex beneficiary on file. Nothing in an email can change that.` },
    instructs
      ? { id: "instructions", ok: false, label: "Instructions for an assistant", detail: "The email tries to instruct an AI. It is data, so the instruction is ignored and the request is held." }
      : { id: "instructions", ok: true, label: "No instructions for an assistant", detail: "Nothing in the email is addressed to an AI." },
    states
      ? { id: "amount", ok: true, label: "Amount matches the invoice", detail: `${request.reference} for ${amount} is stated in the email itself.` }
      : { id: "amount", ok: false, label: "Amount not in the email", detail: `The email does not state ${request.reference} for ${amount}, so the figures cannot be matched.` },
    withinLimit
      ? { id: "limit", ok: true, label: "Within the payout limit", detail: `${amount} is within the ${formatMinor(ctx.maxAmountMinor, request.currency)} this account pays without more review.` }
      : { id: "limit", ok: false, label: "Over the payout limit", detail: `${amount} is above the ${formatMinor(ctx.maxAmountMinor, request.currency)} limit for one payout.` },
    ctx.existing
      ? { id: "reference", ok: false, label: "Already on the ledger", detail: `${request.reference} is already an invoice here. A second copy is filed with it, never opened as a new one.` }
      : { id: "reference", ok: true, label: "A new invoice", detail: `${request.reference} is not on the ledger yet.` },
  ];

  if (ctx.existing) {
    return { verdict: "DUPLICATE", checks, summary: `${request.reference} is already on the ledger. This copy is filed with it, so the invoice can only be paid once.` };
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    return { verdict: "HELD", checks, summary: `Held for a person: ${failed.map((c) => c.label.toLowerCase()).join(", ")}. No invoice was opened and nothing was paid.` };
  }
  return { verdict: "PAYABLE", checks, summary: `Every check passed. A person can approve ${amount} to ${ctx.vendor.legalName}, at the account on file.` };
}
