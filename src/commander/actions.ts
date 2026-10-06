/** What the Commander can recommend. One list, shared by the policy and the wire contract. */
export const ACTION_KINDS = [
  "NONE",
  "WAIT",
  "RECOVER_INTENT",
  "SEND_STATUS_TO_SUPPLIER",
  "SEND_PROOF_TO_SUPPLIER",
  "REQUEST_CORRECTION",
  "REPLACE",
  "CLOSE",
  "ESCALATE",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const SEVERITIES = ["ROUTINE", "ATTENTION", "CRITICAL"] as const;
export type Severity = (typeof SEVERITIES)[number];
