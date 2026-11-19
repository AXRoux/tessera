/**
 * Supplier issues close themselves once they are truly settled. On every sweep, an invoice opened as a supplier issue
 * (CASE_OPENED) is certified when the money reached the supplier, every message from them has been read or answered by
 * a person, and the Commander's own decision is to close: paid, held through the hold window, nothing disputed. The
 * Closer then proves the books against Airwallex exactly as it would for a person's or the agent's request, and refuses
 * the same way. Nothing else is certified here: an ordinary invoice is still the agent's or a person's to close.
 */
import type { Closer } from "../closer/closer";
import type { Commander } from "../commander/commander";
import { effectiveEvidence, EvidenceRecordedSchema } from "../commander/evidence";
import type { Ledger } from "../ledger/ledger";

export async function certifySettledIssues(deps: { ledger: Ledger; commander: Commander; closer: Closer }): Promise<string[]> {
  const { ledger, commander, closer } = deps;
  const certified: string[] = [];
  for (const o of ledger.listObligations()) {
    if (o.status === "CLOSED" || o.status === "ESCALATED") continue;
    const events = ledger.events(o.id);
    if (!events.some((e) => e.type === "CASE_OPENED")) continue;
    const latest = ledger.latestAttempt(o.id);
    const card = ledger.invoiceCard(o.id);
    if (!(latest?.state === "PAID" || (card !== null && card.spentMinor > 0))) continue;
    // Every supplier message read, or a person's own word recorded since the last one arrived.
    const lastMessage = events.findLast((e) => e.type === "INBOX_RECEIVED")?.seq ?? 0;
    const records = events.flatMap((e) => (e.type === "EVIDENCE_RECORDED" ? [{ seq: e.seq, p: EvidenceRecordedSchema.safeParse(e.payload).data }] : []));
    const answeredByPerson = records.some((r) => r.seq > lastMessage && r.p?.source === "manual");
    const read = new Set(events.flatMap((e) => (e.type === "EVIDENCE_RECORDED" ? [(e.payload as { messageId?: unknown }).messageId] : [])));
    if (!answeredByPerson && ledger.inboxMessages(o.id).some((m) => !read.has(m.id))) continue;
    try {
      const evidence = effectiveEvidence(events, o.amountMinor)?.evidence ?? null;
      const { decision } = await commander.assess(o.id, evidence);
      if (decision.recommended !== "CLOSE" || !decision.allowed.includes("CLOSE")) continue;
      await commander.assertCloseAllowed(o.id, evidence);
      await closer.close(o.id);
      certified.push(o.id);
    } catch {
      // Not ready, or the books do not tie yet: the next sweep looks again.
    }
  }
  return certified;
}
