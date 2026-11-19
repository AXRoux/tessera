/**
 * Investigating a supplier message that may not be from the supplier. Code only, like the door (intake.ts): no model
 * decides whether a message is genuine, and the agent that asks for an investigation never sees the text. It gets the
 * verdict and the red flags.
 *
 * Every check compares the message with something Tessera already knows and the sender cannot change:
 *   sender        the address against the vendor record's billing domain: a look-alike, a personal mailbox, a stranger
 *   bank details  any account in the message against the account on file (Tessera only ever pays the one on file)
 *   invoice       what the message says about the invoice against the ledger ("overdue" on an invoice already paid)
 *   instructions  orders aimed at an AI assistant
 *   pressure      urgency, the oldest lever in payment fraud
 *
 * The record keeps the sender, the verdict and the findings; never the message text. Bank details are kept only as a
 * country and the last four characters.
 */
import { domainOf } from "./intake";
import { DETAIL_CHANGE, EMBEDDED_INSTRUCTION } from "./evidence";
import { supplierById } from "../demo/suppliers";
import { StateConflict } from "../errors";
import { paidObservedAt } from "../ledger/events";
import type { Ledger } from "../ledger/ledger";
import { formatMinor } from "../money";

export type Verdict = "impersonation" | "suspicious" | "clear";

export interface InvestigationCheck {
  id: "sender" | "bank" | "invoice" | "instructions" | "pressure";
  ok: boolean;
  /** A strong flag on its own makes a message suspicious; two make it likely impersonation. */
  strong: boolean;
  label: string;
  detail: string;
}

export interface Investigation {
  messageId: string;
  from: string;
  verdict: Verdict;
  /** "Likely impersonation", "Suspicious", "Nothing suspicious found". */
  label: string;
  /** One sentence: the verdict and every red flag. */
  summary: string;
  checks: InvestigationCheck[];
  /** What a person should do, in order. */
  nextSteps: string[];
}

/** What Tessera holds about who should be paid: the vendor record, and the account it pays. */
export interface VendorOnFile {
  name: string;
  /** The only domain its billing mail is trusted from. */
  domain: string;
  /** The account on file, as a person would recognise it. */
  account: { bank: string; last4: string; routing?: string } | null;
}

/** What the ledger says about the invoice the message is about. */
export interface InvoiceOnLedger {
  reference: string;
  amountMinor: number;
  currency: string;
  /** "paid", "paid and certified", "in transit", "returned", "not paid yet". */
  standing: "paid" | "certified" | "in-transit" | "returned" | "unpaid";
  /** When the ledger saw it paid, if it was. */
  paidAt: string | null;
}

const LABEL: Record<Verdict, string> = { impersonation: "Likely impersonation", suspicious: "Suspicious", clear: "Nothing suspicious found" };

/** Personal mailboxes: a supplier's billing never comes from one. */
const PERSONAL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com", "aol.com",
  "protonmail.com", "proton.me", "pm.me", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "qq.com",
]);

const IBAN = /\b([A-Z]{2})\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/;
const ACCOUNT = /\b(?:account|acct)(?:\s*(?:number|no\.?|#))?\s*[:#]?\s*(\d{6,17})\b/i;
const ROUTING = /\brouting(?:\s*(?:number|no\.?))?\s*[:#]?\s*(\d{9})\b/i;
const OVERDUE = /\b(?:overdue|past due|outstanding|unpaid|not (?:yet )?(?:been )?(?:paid|received)|(?:hasn'?t|has not|haven'?t|have not|never) (?:arrived|been paid|received|shown up))\b/i;
const PRESSURE = /\b(?:urgent(?:ly)?|immediately|right away|asap|today|final notice|within 24 hours|now)\b/gi;

/** The registrable name of a domain, without its last label: "framer-invoices.com" is "framer-invoices". */
const baseOf = (domain: string): string => domain.split(".").slice(0, -1).join(".");

/** Edit distance, for names one or two keystrokes from the real one ("framr", "fraamer"). */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j]!;
      row[j] = next;
    }
  }
  return row[b.length]!;
}

function senderCheck(from: string, vendor: VendorOnFile | null): InvestigationCheck {
  const domain = domainOf(from);
  if (!vendor) {
    return { id: "sender", ok: true, strong: false, label: "No vendor record to check the sender against", detail: `Sent from ${domain || "an unknown address"}. This invoice has no vendor record on file.` };
  }
  const own = vendor.domain.toLowerCase();
  if (domain === own || domain.endsWith(`.${own}`)) {
    return { id: "sender", ok: true, strong: false, label: `Sent from ${own}`, detail: `${from} is on ${vendor.name}'s billing domain, as the vendor record has it.` };
  }
  if (PERSONAL.has(domain)) {
    return { id: "sender", ok: false, strong: true, label: `Sent from a personal mailbox (${domain})`, detail: `${vendor.name} bills from ${own}. This came from ${from}, a personal mailbox anyone can open.` };
  }
  const name = baseOf(own);
  const base = baseOf(domain);
  const lookalike = name.length >= 3 && (domain.includes(name) || distance(base, name) <= 2);
  return lookalike
    ? { id: "sender", ok: false, strong: true, label: `${domain} is a look-alike of ${own}`, detail: `${vendor.name} bills from ${own}. ${domain} borrows the name but is a different domain, which anyone can register.` }
    : { id: "sender", ok: false, strong: true, label: `Sent from ${domain || "an unknown address"}, not ${own}`, detail: `${vendor.name} bills from ${own}. This came from ${from}.` };
}

function bankCheck(text: string, vendor: VendorOnFile | null): InvestigationCheck {
  const onFile = vendor?.account ? `the account on file (${vendor.account.bank}, ending ${vendor.account.last4})` : "the account on file";
  const iban = text.toUpperCase().match(IBAN);
  const account = text.match(ACCOUNT);
  const routing = text.match(ROUTING);
  if (iban) {
    const last4 = iban[0].replace(/\s/g, "").slice(-4);
    return { id: "bank", ok: false, strong: true, label: `New bank details: a ${iban[1]} account ending ${last4}`, detail: `The message gives an IBAN in ${iban[1]} ending ${last4}, not ${onFile}. Tessera only ever pays the account on file.` };
  }
  if (account) {
    const last4 = account[1]!.slice(-4);
    const same = vendor?.account && last4 === vendor.account.last4 && (!routing || routing[1] === vendor.account.routing);
    return same
      ? { id: "bank", ok: true, strong: false, label: "Names the account on file", detail: `The account it names ends ${last4}, the same as ${onFile}.` }
      : { id: "bank", ok: false, strong: true, label: `New bank details: an account ending ${last4}`, detail: `The message names an account ending ${last4}, not ${onFile}. Tessera only ever pays the account on file.` };
  }
  if (DETAIL_CHANGE.test(text)) {
    return { id: "bank", ok: false, strong: true, label: "Asks to change bank details", detail: `It asks to pay somewhere other than ${onFile}. A change of bank details is confirmed by phone, on a number already on file.` };
  }
  return { id: "bank", ok: true, strong: false, label: "No new bank details", detail: `Nothing in it asks to pay anywhere but ${onFile}.` };
}

function invoiceCheck(text: string, invoice: InvoiceOnLedger): InvestigationCheck {
  const cites = text.toLowerCase().includes(invoice.reference.toLowerCase());
  const claimsUnpaid = OVERDUE.test(text);
  const amount = formatMinor(invoice.amountMinor, invoice.currency);
  const when = invoice.paidAt ? ` on ${new Date(invoice.paidAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}` : "";
  if ((invoice.standing === "paid" || invoice.standing === "certified") && claimsUnpaid) {
    return { id: "invoice", ok: false, strong: true, label: `Says ${invoice.reference} is unpaid, but it was paid${when}`, detail: `The ledger shows ${invoice.reference} for ${amount} paid${when} to the account on file${invoice.standing === "certified" ? " and certified" : ""}. A demand to pay it again is a red flag.` };
  }
  if (!cites) {
    return { id: "invoice", ok: false, strong: false, label: `Does not cite ${invoice.reference}`, detail: `It never names ${invoice.reference}, so nothing it claims is matched to an invoice on file.` };
  }
  const standing = { paid: `paid${when}`, certified: `paid${when} and certified`, "in-transit": "in transit", returned: "returned by the bank, money back", unpaid: "not paid yet" }[invoice.standing];
  return { id: "invoice", ok: true, strong: false, label: `Cites ${invoice.reference}, which is ${standing}`, detail: `What it says about ${invoice.reference} does not contradict the ledger.` };
}

/** Investigates one message against the vendor record and the ledger. Pure: the caller records the result. */
export function investigate(input: { messageId: string; from: string; text: string; vendor: VendorOnFile | null; invoice: InvoiceOnLedger }): Investigation {
  const { text, vendor, invoice } = input;
  const pressure = [...new Set([...text.matchAll(PRESSURE)].map((m) => m[0].toLowerCase()))];
  const checks: InvestigationCheck[] = [
    senderCheck(input.from, vendor),
    bankCheck(text, vendor),
    invoiceCheck(text, invoice),
    EMBEDDED_INSTRUCTION.test(text)
      ? { id: "instructions", ok: false, strong: true, label: "Orders aimed at an AI assistant", detail: "It tries to instruct an assistant. A supplier has no reason to; the instructions were ignored." }
      : { id: "instructions", ok: true, strong: false, label: "No instructions for an assistant", detail: "Nothing in it is addressed to an AI assistant." },
    pressure.length > 0
      ? { id: "pressure", ok: false, strong: false, label: `Pressure: ${pressure.map((w) => `“${w}”`).join(", ")}`, detail: "Urgency is how payment fraud gets a person to skip a check." }
      : { id: "pressure", ok: true, strong: false, label: "No pressure to act fast", detail: "Nothing in it pushes for speed." },
  ];
  const flags = checks.filter((c) => !c.ok);
  const strong = flags.filter((c) => c.strong).length;
  const verdict: Verdict = strong >= 2 ? "impersonation" : strong === 1 || flags.length >= 2 ? "suspicious" : "clear";
  const who = vendor?.name ?? "the supplier";
  const nextSteps =
    verdict === "clear"
      ? ["Nothing in the message conflicts with the vendor record or the ledger."]
      : [
          "Do not pay any account named in the message. Tessera will not: it pays only the account on file.",
          `Call ${who} on the phone number on the vendor record, never one from the message, and ask whether they sent it.`,
          ...(verdict === "impersonation" ? [`Report ${domainOf(input.from) || "the sender"} to your security team.`] : []),
          ...(vendor ? [`If you reply, write to an address at ${vendor.domain}, not to the sender.`] : []),
        ];
  const label = LABEL[verdict];
  const summary =
    flags.length === 0
      ? `${label}: the sender, the bank details and the invoice all agree with what is on file.`
      : `${label}: ${flags.length} red ${flags.length === 1 ? "flag" : "flags"}. ${flags.map((f) => f.label).join("; ")}.`;
  return { messageId: input.messageId, from: input.from, verdict, label, summary, checks, nextSteps };
}

/**
 * Investigates the latest supplier message on an invoice (or the one named) and records the findings on the ledger as
 * INVESTIGATED, under `by`. The vendor record is the supplier on file the invoice was opened for, if it was.
 */
export function investigateIncident(ledger: Ledger, obligationId: string, by: string, messageId?: string): Investigation {
  const o = ledger.requireObligation(obligationId);
  const messages = ledger.inboxMessages(obligationId);
  const message = messageId ? messages.find((m) => m.id === messageId) : messages.at(-1);
  if (!message) throw new StateConflict(messageId ? `no message ${messageId} on this invoice` : "there is no supplier message on this invoice to investigate");
  const request = ledger.requestForObligation(obligationId);
  const supplier = request ? supplierById(request.supplierId) : undefined;
  const vendor: VendorOnFile | null = supplier
    ? { name: supplier.name, domain: supplier.domain, account: { bank: supplier.payee.bankName, last4: supplier.payee.accountNumber.slice(-4), routing: supplier.payee.routingNumber } }
    : null;
  const latest = ledger.latestAttempt(obligationId);
  const card = ledger.invoiceCard(obligationId);
  const standing: InvoiceOnLedger["standing"] =
    o.status === "CLOSED" ? "certified"
      : latest?.state === "PAID" || (card !== null && card.spentMinor > 0) ? "paid"
        : latest?.state === "LIVE" || latest?.state === "INTENT" ? "in-transit"
          : latest?.state === "DEAD" ? "returned"
            : "unpaid";
  const paidAt = latest?.state === "PAID" ? paidObservedAt(ledger.events(obligationId), latest.id) : null;
  const result = investigate({
    messageId: message.id, from: message.from, text: `${message.email}\n${message.statementText ?? ""}`, vendor,
    invoice: { reference: o.reference, amountMinor: o.amountMinor, currency: o.currency, standing, paidAt },
  });
  ledger.append(obligationId, "INVESTIGATED", { ...result, by });
  return result;
}
