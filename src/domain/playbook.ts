/**
 * Failure code -> response class -> replacement policy.
 * Keyed on `failure.code` (lossless across the 32 sandbox failure types; `failure.details.type` is not).
 * Captured from the sandbox in fixtures/failure-codes.json; the docs' failure table disagrees with it.
 */
export type FailureClass =
  | "FIX_DETAILS"
  | "SUPPLIER_ACCOUNT"
  | "TRANSIENT"
  | "FUNDING_OR_LIMITS"
  | "POSSIBLE_DUPLICATE"
  | "COMPLIANCE_OR_RECALL"
  | "CORRIDOR_UNSUPPORTED"
  | "UNKNOWN";

/** AUTO: replace freely. AFTER_CHANGE: something must objectively change, or a human vouches in writing. FORBIDDEN: human only. */
export type ReplacePolicy = "AUTO" | "AFTER_CHANGE" | "FORBIDDEN";
export type RequiredChange = "BENEFICIARY" | "REASON" | "METHOD";

export interface PlaybookEntry {
  code: string;
  failureType: string;
  class: FailureClass;
  replace: ReplacePolicy;
  change?: RequiredChange;
  /** Escalate to a person instead of letting an agent decide. */
  escalate: boolean;
  guidance: string;
}

const GUIDANCE: Record<FailureClass, string> = {
  FIX_DETAILS:
    "Airwallex rejected the payout details. Get corrected details from the supplier, confirm them by phone, then send a replacement.",
  SUPPLIER_ACCOUNT:
    "The supplier's bank would not accept the funds. Ask the supplier for a working account, confirm it by phone, then send a replacement.",
  TRANSIENT:
    "A temporary fault on the payment rails. Once the original is cancelled and the money is back in the wallet, it is safe to send again.",
  FUNDING_OR_LIMITS:
    "The payment hit a balance, limit or fee problem. Fix the cause, whether that is a top-up or a different payment method, then send a replacement.",
  POSSIBLE_DUPLICATE:
    "A bank flagged this as a duplicate, so the supplier may already hold the money. Do not replace it without proof that nothing arrived.",
  COMPLIANCE_OR_RECALL:
    "A compliance hold or a recall request. A replacement could run into the same block, or undo a legitimate recall. A person has to decide.",
  CORRIDOR_UNSUPPORTED:
    "This failure comes from a payment corridor PayOnce does not handle for supplier payouts. A person should take over.",
  UNKNOWN: "Airwallex reported a failure PayOnce cannot classify. A person should take over.",
};

const row = (
  code: string,
  failureType: string,
  cls: FailureClass,
  replace: ReplacePolicy,
  change?: RequiredChange,
): PlaybookEntry => ({
  code,
  failureType,
  class: cls,
  replace,
  ...(change ? { change } : {}),
  escalate: replace === "FORBIDDEN",
  guidance: GUIDANCE[cls],
});

const ENTRIES: PlaybookEntry[] = [
  row("90101", "INVALID_ACCOUNT_NAME_OR_NUMBER", "FIX_DETAILS", "AFTER_CHANGE", "BENEFICIARY"),
  row("90201", "INVALID_BANK_OR_BRANCH_CODE", "FIX_DETAILS", "AFTER_CHANGE", "BENEFICIARY"),
  row("90202", "INVALID_SWIFT_BIC_CODE", "FIX_DETAILS", "AFTER_CHANGE", "BENEFICIARY"),
  row("90203", "INVALID_CORRESPONDENT_BANK_INFORMATION", "FIX_DETAILS", "AFTER_CHANGE", "BENEFICIARY"),
  row("90204", "INVALID_BANK_INFORMATION", "FIX_DETAILS", "AFTER_CHANGE", "BENEFICIARY"),
  row("90301", "BENEFICIARY_NAME_MISMATCH", "FIX_DETAILS", "AFTER_CHANGE", "BENEFICIARY"),
  row("90302", "ACCOUNT_CURRENCY_MISMATCH", "FIX_DETAILS", "AFTER_CHANGE", "BENEFICIARY"),
  row("90401", "INVALID_BENEFICIARY_DETAILS", "FIX_DETAILS", "AFTER_CHANGE", "BENEFICIARY"),
  row("90402", "INVALID_SPECIAL_CHARACTER", "FIX_DETAILS", "AFTER_CHANGE", "BENEFICIARY"),
  row("91101", "INVALID_PAYMENT_PURPOSE", "FIX_DETAILS", "AFTER_CHANGE", "REASON"),

  row("90701", "ACCOUNT_CLOSED", "SUPPLIER_ACCOUNT", "AFTER_CHANGE", "BENEFICIARY"),
  row("90702", "ACCOUNT_INACTIVE_OR_DORMANT", "SUPPLIER_ACCOUNT", "AFTER_CHANGE", "BENEFICIARY"),
  row("90703", "ACCOUNT_UNDER_RESTRICTION", "SUPPLIER_ACCOUNT", "AFTER_CHANGE", "BENEFICIARY"),
  row("90801", "BENEFICIARY_REQUESTED", "SUPPLIER_ACCOUNT", "AFTER_CHANGE", "BENEFICIARY"),
  row("90802", "BENEFICIARY_BANK_RETURNED", "SUPPLIER_ACCOUNT", "AFTER_CHANGE", "BENEFICIARY"),

  row("91401", "SYSTEM_ERROR", "TRANSIENT", "AUTO"),
  row("91402", "CHANNEL_TIMEOUT", "TRANSIENT", "AUTO"),

  row("90601", "EXCEEDED_TRANSACTION_AMOUNT_OR_LIMIT", "FUNDING_OR_LIMITS", "AFTER_CHANGE", "METHOD"),
  row("90602", "INSUFFICIENT_FUNDS", "FUNDING_OR_LIMITS", "AUTO"),
  row("90603", "TRANSACTION_AMOUNT_NOT_COVERING_FEE", "FUNDING_OR_LIMITS", "AFTER_CHANGE", "METHOD"),

  row("91301", "DUPLICATION_RETURN", "POSSIBLE_DUPLICATE", "FORBIDDEN"),

  row("90501", "CHANNEL_POLICY", "COMPLIANCE_OR_RECALL", "FORBIDDEN"),
  row("90502", "TM_SUSPENDED", "COMPLIANCE_OR_RECALL", "FORBIDDEN"),
  row("91001", "RECALL_REQUESTED", "COMPLIANCE_OR_RECALL", "FORBIDDEN"),
  row("91002", "CLIENT_REQUESTED", "COMPLIANCE_OR_RECALL", "FORBIDDEN"),

  row("90901", "INBOUND_BENFICIARY_VALIDATION_ERROR", "CORRIDOR_UNSUPPORTED", "FORBIDDEN"),
  row("90902", "INBOUND_ORDER_ERROR", "CORRIDOR_UNSUPPORTED", "FORBIDDEN"),
  row("90903", "INBOUND_2B_CARD_NOT_SUPPORTED", "CORRIDOR_UNSUPPORTED", "FORBIDDEN"),
  row("90904", "INBOUND_COMPANY_REGISTRATION_NUMBER_ERROR", "CORRIDOR_UNSUPPORTED", "FORBIDDEN"),
  row("91201", "CARD_ISSUER_ERROR", "CORRIDOR_UNSUPPORTED", "FORBIDDEN"),

  row("99901", "UNABLE_TO_APPLY", "UNKNOWN", "FORBIDDEN"),
  row("99902", "OTHER", "UNKNOWN", "FORBIDDEN"),
];

export const PLAYBOOK: Readonly<Record<string, PlaybookEntry>> = Object.fromEntries(
  ENTRIES.map((entry) => [entry.code, entry]),
);

const UNRECOGNIZED: PlaybookEntry = {
  code: "UNRECOGNIZED",
  failureType: "UNRECOGNIZED",
  class: "UNKNOWN",
  replace: "FORBIDDEN",
  escalate: true,
  guidance: GUIDANCE.UNKNOWN,
};

/** Unknown or missing codes fail closed. */
export function lookupFailure(code: string | null | undefined): PlaybookEntry {
  // hasOwn: a code such as "constructor" must not resolve through the prototype chain.
  return code && Object.hasOwn(PLAYBOOK, code) ? PLAYBOOK[code]! : UNRECOGNIZED;
}
