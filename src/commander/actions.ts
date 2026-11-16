/** What the Commander can recommend. One list, shared by the policy and the wire contract. */
export const ACTION_KINDS = [
  "NONE",
  "WAIT",
  "RECOVER_INTENT",
  "SEND_STATUS_TO_SUPPLIER",
  "SEND_PROOF_TO_SUPPLIER",
  "REQUEST_CORRECTION",
  "REPLACE",
  /** Convert from another wallet so a replacement the code would otherwise make can be paid (see FundingPlan). */
  "FUND",
  /**
   * Pay the invoice with a single-use Visa card instead of a second transfer: allowed only where a replacement would be.
   * The agent asks for the card (its terms come from the invoice), a named person signs it, then the agent pays the
   * supplier's checkout through Visa's Trusted Agent Protocol.
   */
  "PAY_BY_CARD",
  "CLOSE",
  "ESCALATE",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const SEVERITIES = ["ROUTINE", "ATTENTION", "CRITICAL"] as const;
export type Severity = (typeof SEVERITIES)[number];
