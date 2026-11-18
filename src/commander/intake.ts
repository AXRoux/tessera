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
      ? { id: "sender", ok: true, label: "Sender on file", detail: `${request.sender} matches ${ctx.vendor.name}'s billing domain on the vendor record.` }
      : { id: "sender", ok: false, label: "Sender not on file", detail: `${ctx.vendor.name} bills from ${ctx.vendor.domain}. This came from ${domain || "an unknown address"}.` },
    changesBank
      ? { id: "payee", ok: false, label: "Asks to change bank details", detail: `The email gives different bank details. Payments go only to ${ctx.vendor.legalName}'s account on file; confirm any change by phone on a number you already hold.` }
      : { id: "payee", ok: true, label: "Pays the account on file", detail: `Payment goes to ${ctx.vendor.legalName}'s account on file at Airwallex.` },
    instructs
      ? { id: "instructions", ok: false, label: "Instructions for an AI assistant", detail: "The email contains instructions aimed at an AI assistant. They were ignored." }
      : { id: "instructions", ok: true, label: "No embedded instructions", detail: "Nothing in the email is addressed to an AI assistant." },
    states
      ? { id: "amount", ok: true, label: "Amount matches the invoice", detail: `${request.reference} for ${amount} matches the email.` }
      : { id: "amount", ok: false, label: "Amount not in the email", detail: `The email does not state ${request.reference} for ${amount}, so the figures cannot be matched.` },
    withinLimit
      ? { id: "limit", ok: true, label: "Within the payout limit", detail: `${amount} is within the ${formatMinor(ctx.maxAmountMinor, request.currency)} single-payment limit.` }
      : { id: "limit", ok: false, label: "Over the payout limit", detail: `${amount} is above the ${formatMinor(ctx.maxAmountMinor, request.currency)} limit for one payout.` },
    ctx.existing
      ? { id: "reference", ok: false, label: "Already being paid", detail: `${request.reference} is already open. This copy is filed with it rather than paid again.` }
      : { id: "reference", ok: true, label: "New invoice", detail: `${request.reference} has not been paid before.` },
  ];

  if (ctx.existing) {
    return { verdict: "DUPLICATE", checks, summary: `${request.reference} is already being paid. This copy is filed with it.` };
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    return { verdict: "HELD", checks, summary: `On hold: ${failed.map((c) => c.label.toLowerCase()).join(", ")}. Nothing has been opened or paid.` };
  }
  return { verdict: "PAYABLE", checks, summary: `Verified. Ready for your approval: ${amount} to ${ctx.vendor.legalName}, at the account on file.` };
}
