/**
 * Board numbers, derived from the ledger alone: what code refused, what was replaced, what was certified and how long
 * that took. Nothing here is counted by a process in memory, so every number can be recomputed from the chain.
 */
import { z } from "zod";
import type { Ledger } from "../ledger/ledger";
import type { Metrics } from "./wire";

const ToolCallSchema = z.object({ tool: z.string(), outcome: z.string() });
const IntentSchema = z.object({ mode: z.string(), replaces: z.string().nullable() });

export function computeMetrics(ledger: Ledger): Metrics {
  const obligations = new Map(ledger.listObligations().map((o) => [o.id, o]));
  let autoReplaced = 0;
  let paymentsRefused = 0;
  let agentRefusals = 0;
  const refusedAmountMinor: Record<string, number> = {};
  const closedAt = new Map<string, string>();

  const refuse = (obligationId: string | null) => {
    paymentsRefused++;
    const o = obligationId ? obligations.get(obligationId) : undefined;
    if (o) refusedAmountMinor[o.currency] = (refusedAmountMinor[o.currency] ?? 0) + o.amountMinor;
  };

  for (const event of ledger.events()) {
    switch (event.type) {
      case "AGENT_TOOL_CALL": {
        const call = ToolCallSchema.safeParse(event.payload).data;
        if (call?.outcome !== "refused") break;
        agentRefusals++;
        if (call.tool === "replace_payment") refuse(event.obligationId);
        break;
      }
      case "PAYMENT_REFUSED":
        refuse(event.obligationId);
        break;
      case "ATTEMPT_INTENT": {
        const intent = IntentSchema.safeParse(event.payload).data;
        if (intent?.mode === "POLICY" && intent.replaces !== null) autoReplaced++;
        break;
      }
      case "CLOSED":
        if (event.obligationId) closedAt.set(event.obligationId, event.ts);
        break;
    }
  }

  const all = [...obligations.values()];
  const certified = all.filter((o) => o.status === "CLOSED");
  const durations = certified
    .flatMap((o) => {
      const at = closedAt.get(o.id);
      return at ? [Date.parse(at) - Date.parse(o.createdAt)] : [];
    })
    .sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const medianResolutionMs =
    durations.length === 0 ? null : durations.length % 2 === 1 ? durations[mid]! : Math.round((durations[mid - 1]! + durations[mid]!) / 2);

  return {
    incidents: all.length,
    open: all.filter((o) => o.status !== "CLOSED").length,
    escalated: all.filter((o) => o.status === "ESCALATED").length,
    certified: certified.length,
    autoReplaced,
    paymentsRefused,
    refusedAmountMinor,
    agentRefusals,
    medianResolutionMs,
  };
}
