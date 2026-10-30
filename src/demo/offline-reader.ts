/**
 * The evidence reader for the offline demo: deterministic keyword and pattern extraction, not Claude. It fills the same
 * schema the model fills, and its answer goes through the same code cross-check (`readSupplierMessage`), so the policy
 * cannot tell the two apart. Its summary says what it is.
 */
import { ExtractedEvidenceSchema, type ExtractedEvidence, type ExtractRequest, type StructuredModel } from "../commander/evidence";
import { toMinor } from "../money";

export const OFFLINE_READER_LABEL = "offline reader, not Claude";

const NON_RECEIPT = [
  /\b(?:hasn'?t|has not|haven'?t|have not|not|never|cannot|can'?t|couldn'?t|didn'?t|did not)\b[^.\n]{0,60}\b(?:arriv\w*|receiv\w*|shown? up|turned up|land\w*|find|found|see|seen|reach\w*)\b/i,
  /\bnothing\b[^.\n]{0,20}\b(?:arrived|received|came|showed up)\b/i,
  /\bwhere is\b[^.\n]{0,20}\b(?:payment|money|transfer|funds)\b/i,
];
const DETAIL_CHANGE =
  /\b(?:new|updated|changed|change|different|revised|switch(?:ed)?)\b[^.\n]{0,40}\b(?:banks?|accounts?|iban|swift|bic|routing)\b|\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,}/i;
const INSTRUCTION =
  /\b(?:ignore|disregard|forget)\b[^.\n]{0,30}\b(?:previous|prior|above|all|instructions)\b|system prompt|you are now|\bdo(?: not|n'?t) tell\b|\bas an? (?:ai|assistant|language model)\b/i;
const CREDIT_LINE = /\b(?:credit(?:ed)?|received|deposit(?:ed)?|incoming)\b/i;
const NEGATED = /\b(?:no|not|none|nothing|without)\b/i;
const MONEY = /(?<![\d.])(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)(?![\d.])/;

/** Pulls the tagged sections and the header lines out of the reader prompt built by `readSupplierMessage`. */
function section(text: string, tag: string): string {
  return text.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? "";
}

export function extractOffline(prompt: string): ExtractedEvidence {
  const reference = prompt.match(/^Obligation reference: (.+)$/m)?.[1]?.trim() ?? "";
  const currency = prompt.match(/^Amount we sent: \S+ ([A-Z]{3})$/m)?.[1] ?? "USD";
  const email = section(prompt, "supplier_email");
  const statement = section(prompt, "supplier_bank_statement");
  const both = `${email}\n${statement}`;

  const claimsNonReceipt = NON_RECEIPT.some((pattern) => pattern.test(email));
  const requestsDetailChange = DETAIL_CHANGE.test(email);
  const containsEmbeddedInstructions = INSTRUCTION.test(both);
  const referencesObligation = reference.length > 0 && email.toLowerCase().includes(reference.toLowerCase());

  let statementCredit: ExtractedEvidence["statementCredit"] = null;
  for (const line of statement.split(/\n|(?<=\.)\s+/)) {
    if (!CREDIT_LINE.test(line) || NEGATED.test(line)) continue;
    const amount = line.match(MONEY)?.[1];
    if (!amount) continue;
    const minor = toMinor(Number(amount.replace(/,/g, "")), currency);
    if (minor > 0) {
      statementCredit = { amountMinor: minor, currency };
      break;
    }
  }

  const found = [
    claimsNonReceipt && "says the payment did not arrive",
    requestsDetailChange && "asks to change bank details",
    containsEmbeddedInstructions && "contains instructions aimed at an assistant",
    statementCredit && "statement shows a credit",
    !referencesObligation && "does not cite the invoice reference",
  ].filter((s): s is string => typeof s === "string");
  const summary = `${OFFLINE_READER_LABEL}: ${found.length > 0 ? found.join("; ") : "no payment claims found"}.`;

  return { claimsNonReceipt, requestsDetailChange, referencesObligation, statementCredit, containsEmbeddedInstructions, summary };
}

/** A `StructuredModel` that never leaves the process. Only the supplier-evidence extraction is supported. */
export class OfflineReader implements StructuredModel {
  async extract<T>(request: ExtractRequest<T>): Promise<T> {
    return request.schema.parse(ExtractedEvidenceSchema.parse(extractOffline(request.user)));
  }
}
