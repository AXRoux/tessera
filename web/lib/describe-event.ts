function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : {};
}

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** Free text from a person or an agent often ends in its own full stop; sentences here add theirs. */
const bare = (value: string | null): string | null => (value === null ? null : value.replace(/[.\s]+$/, ""));

const APPROVER_KIND: Record<string, string> = { HUMAN: "a person", POLICY: "policy" };

/** One plain sentence per ledger event type. Unknown types fall back to their name, so nothing is ever hidden. */
export function describeEvent(type: string, payload: unknown): string {
  const p = record(payload);
  switch (type) {
    case "OBLIGATION_CREATED":
      return "Invoice recorded.";
    case "ATTEMPT_INTENT": {
      const note = text(p.note);
      const kind = APPROVER_KIND[text(p.mode) ?? ""] ?? "unknown";
      return `Attempt ${String(p.seq)} was recorded before any money moved. Approved by ${text(p.approver) ?? "unknown"} (${kind})${note ? `: "${note}"` : "."}`;
    }
    case "TRANSFER_STATUS": {
      const from = text(p.from);
      const code = text(p.failureCode);
      const move = from ? `moved the transfer from ${from} to ${text(p.to) ?? "an unknown state"}` : `accepted the transfer as ${text(p.to) ?? "new"}`;
      return `Airwallex ${move}${code ? `, with failure code ${code}` : ""}.`;
    }
    case "LATE_FAILURE":
      return `A transfer reported as paid was returned afterwards (code ${text(p.failureCode) ?? "unknown"}). The incident reopened.`;
    case "CREATE_AMBIGUOUS":
      return "The request to Airwallex timed out without a clear answer. Tessera looks it up by its original request ID rather than sending a new one.";
    case "TRANSFER_MISMATCH":
      return text(p.detail) ?? "Airwallex returned a transfer that does not match the ledger. It was held for a person.";
    case "ATTEMPT_ABANDONED":
      return `Airwallex rejected the request outright, so nothing was sent: ${text(p.reason) ?? "no reason given"}.`;
    case "STATUS_AFTER_DEAD":
      return `Airwallex reported ${text(p.status) ?? "a new status"} after the transfer was cancelled. Ignored, because the payment was already released.`;
    case "UNKNOWN_STATUS":
      return `Airwallex reported a status Tessera does not recognize (${text(p.status) ?? "unknown"}). The payment stays locked until a person looks.`;
    case "ESCALATED":
      return `Handed to a person: ${bare(text(p.reason)) ?? "no reason recorded"}.`;
    case "EVIDENCE_RECORDED": {
      const evidence = record(p.evidence);
      const by = text(p.enteredBy) ?? "an operator";
      const who = text(p.source) === "model" ? `read by Claude, called by ${by}` : `entered by hand by ${by}`;
      return `Supplier evidence ${who}: ${text(evidence.summary) ?? "no summary"}`;
    }
    case "AGENT_TOOL_CALL": {
      const who = text(p.actor) ?? "an agent";
      const tool = (text(p.tool) ?? "a tool").replaceAll("_", " ");
      const outcome = text(p.outcome);
      if (outcome === "ok") return `${who} used "${tool}".`;
      const detail = bare(text(p.detail));
      return `${who} tried "${tool}" and was ${outcome === "refused" ? "refused" : "turned away"}${detail ? `: ${detail}.` : "."}`;
    }
    case "AGENT_DEFERRED":
      return `${text(p.actor) ?? "An agent"} chose to wait: ${bare(text(p.note)) ?? "no reason recorded"}.`;
    case "CLOSED":
      return "Reconciled against Airwallex and certified.";
    default:
      return type;
  }
}
