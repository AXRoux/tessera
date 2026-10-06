function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : {};
}

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** One plain sentence per ledger event type. Unknown types fall back to their name, so nothing is ever hidden. */
export function describeEvent(type: string, payload: unknown): string {
  const p = record(payload);
  switch (type) {
    case "OBLIGATION_CREATED":
      return "Obligation recorded";
    case "ATTEMPT_INTENT": {
      const note = text(p.note);
      return `Attempt ${String(p.seq)} intent written before any money moved. Approved by ${text(p.approver) ?? "unknown"} (${text(p.mode) ?? "?"})${note ? `: "${note}"` : ""}`;
    }
    case "TRANSFER_STATUS": {
      const code = text(p.failureCode);
      return `Airwallex ${text(p.from) ?? "new"} to ${text(p.to) ?? "?"}${code ? `, failure ${code}` : ""}`;
    }
    case "LATE_FAILURE":
      return `A transfer that was PAID failed afterwards (${text(p.failureCode) ?? "no code"}). The incident reopened.`;
    case "CREATE_AMBIGUOUS":
      return "The create call's outcome was unknown. Resolving by request_id, never with a new one.";
    case "TRANSFER_MISMATCH":
      return text(p.detail) ?? "Airwallex returned a transfer that does not match the ledger.";
    case "ATTEMPT_ABANDONED":
      return `Airwallex rejected the create outright; nothing was sent (${text(p.reason) ?? "no reason"})`;
    case "STATUS_AFTER_DEAD":
      return `Airwallex reported ${text(p.status) ?? "a status"} after cancellation. Ignored; the lock was already released.`;
    case "UNKNOWN_STATUS":
      return `Unrecognized Airwallex status ${text(p.status) ?? "?"}. The lock stays held.`;
    case "ESCALATED":
      return `Escalated to a person: ${text(p.reason) ?? "no reason recorded"}`;
    case "EVIDENCE_RECORDED": {
      const evidence = record(p.evidence);
      return `Supplier evidence from ${text(p.source) ?? "?"} by ${text(p.enteredBy) ?? "?"}: ${text(evidence.summary) ?? "no summary"}`;
    }
    case "CLOSED":
      return "Reconciled and certified";
    default:
      return type;
  }
}
