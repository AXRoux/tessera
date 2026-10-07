import type { ToolOutcome } from "./toolbox";

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

const trim = (text: string, max: number): string => {
  const clean = text.replace(UUID, "").replace(/obligation\s*:?\s*/gi, "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : {};

/** One line a person can read for what a tool call did. Used by the console stream and the terminal demo. */
export function summarize(tool: string, outcome: ToolOutcome): string {
  if (!outcome.ok) {
    if (outcome.kind === "refused") {
      const details = record(outcome.kind === "refused" ? outcome.details : null);
      const blockers = Array.isArray(details.blockers) ? details.blockers.join("; ") : null;
      const reasons = Array.isArray(details.reasons) ? String(details.reasons[0] ?? "") : null;
      return `${outcome.error}: ${trim(blockers ?? reasons ?? outcome.message, 170)}`;
    }
    return trim(outcome.message, 170);
  }
  const r = record(outcome.result);
  switch (tool) {
    case "list_incidents": {
      const incidents = Array.isArray(r.incidents) ? r.incidents.length : 0;
      return `${incidents} incident${incidents === 1 ? "" : "s"}`;
    }
    case "assess_incident": {
      const d = record(r.decision);
      const allowed = Array.isArray(d.allowed) ? d.allowed.join(", ") : "";
      return `recommended ${String(d.recommended)}; allowed: ${allowed}`;
    }
    case "read_supplier_message": {
      const e = record(r.supplierEvidence);
      const flags = [
        e.claimsNonReceipt ? "claims non-receipt" : null,
        e.requestsDetailChange ? "asks to change bank details" : null,
        e.containsEmbeddedInstructions ? "instructions aimed at an assistant" : null,
        e.referencesObligation === false ? "does not cite the invoice" : null,
      ].filter((x): x is string => x !== null);
      return flags.length ? flags.join(" · ") : "nothing unusual";
    }
    case "replace_payment": {
      const a = record(r.attempt);
      return `replacement sent as attempt #${String(a.seq)}`;
    }
    case "defer_incident":
      return typeof r.recheckAt === "string" ? `deferred; look again ${r.recheckAt}` : "deferred";
    case "escalate_to_human":
      return r.alreadyEscalated ? "already with a person" : "handed to a person";
    case "reconcile_and_close":
      return "reconciled; certificate signed";
    case "verify_ledger":
      return r.ok ? "hash chain verifies" : `hash chain broken at event ${String(r.brokenAt)}`;
    case "draft_supplier_reply":
      return "reply drafted for a person to approve";
    default:
      return "ok";
  }
}
