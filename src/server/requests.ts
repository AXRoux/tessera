/**
 * Supplier requests: where a payment starts. A supplier on file sends an invoice; the door (src/commander/intake.ts)
 * checks it in code; a person approves it, which opens the invoice and pays the account on file through the same
 * gateway as every other payment. After that, the invoice's story (src/demo/story.ts) lets the console play the
 * supplier's and the bank's parts on the sandbox or offline.
 *
 *   GET  /api/suppliers                     the vendor records, with the invoice each would send next
 *   GET  /api/requests                      every request, newest first
 *   POST /api/requests        {supplierId}  rehearsal: the supplier sends its invoice (sandbox or offline only)
 *   POST /api/requests/:id/approve {note}   a person approves: the invoice is opened and paid
 *   POST /api/requests/:id/decline {note}   a person turns it down
 *   POST /api/requests/:id/clear            off the Received list, once nothing is left to decide on it
 *   POST /api/obligations/:id/story/play {step}   the supplier's or the bank's next move (sandbox or offline only)
 *   POST /api/supplier-issues               the supplier issues: payments already made and now stuck (src/demo/morning.ts), sandbox or offline only
 */
import { z } from "zod";
import type { BeneficiaryApi } from "../airwallex/types";
import { WRITTEN_NOTE_MIN_CHARS } from "../approval/approval";
import type { Commander } from "../commander/commander";
import { checkIntake } from "../commander/intake";
import { fillCase, MORNING, morningSupplier, type CaseOpened, type MorningCase } from "../demo/morning";
import { effectFor, followUpFor, storySteps } from "../demo/story";
import { dueDate, fill, invoiceTotal, STORIES, supplierById, SUPPLIERS, type StoryId, type Supplier } from "../demo/suppliers";
import { StateConflict } from "../errors";
import type { PayoutGateway } from "../gateway/gateway";
import type { Ledger, Obligation, SupplierRequest } from "../ledger/ledger";
import { formatMinor } from "../money";
import type { Simulator } from "./api";
import type { Reactor } from "./reactions";
import type { MorningResult, Story, SupplierBadge, SupplierCard, SupplierRequestView, Suppliers } from "./wire";

export interface RequestDeps {
  ledger: Ledger;
  gateway: PayoutGateway;
  commander: Commander;
  simulator: Simulator | null;
  /** Finds or creates each supplier's payee at Airwallex. Absent: invoices pay the workspace's default payee. */
  beneficiaries?: Pick<BeneficiaryApi, "listBeneficiaries" | "createBeneficiary"> | null;
  /** The payee used when there is no beneficiary API (tests, a workspace without one). */
  defaultBeneficiaryId: string;
  operator: string;
  /** Largest payout, major units. */
  maxAmount: number;
  reactor?: Pick<Reactor, "react">;
  /** Pause between polls while the bank catches up; tests set it to 0. */
  pollMs?: number;
}

const SendBody = z.object({ supplierId: z.string().min(1).max(40) });
const NoteBody = z.object({ note: z.string().trim().min(WRITTEN_NOTE_MIN_CHARS).max(500) });
export const PlayBody = z.object({ step: z.string().min(1).max(40) });

export const badgeOf = (s: Supplier): SupplierBadge => ({ id: s.id, name: s.name, legalName: s.legalName, tile: s.tile });

/** Polls of a failed transfer (about a second each) before the setup cancels it at the sandbox itself. */
const CANCEL_AFTER_POLLS = 4;

/** True when this invoice was opened from a request with a story: the story plays the bank, not the bank clock. */
export function isStoryInvoice(ledger: Ledger, obligationId: string): boolean {
  const request = ledger.requestForObligation(obligationId);
  return request !== null && request.story !== null;
}

export function createRequests(deps: RequestDeps) {
  const { ledger, gateway, commander } = deps;
  const pollMs = deps.pollMs ?? 1_000;
  const payees = new Map<string, string>();

  /** The supplier's Airwallex beneficiary, looked up by nickname first so a retry never creates two. */
  async function payeeFor(supplier: Supplier): Promise<string> {
    const known = payees.get(supplier.id);
    if (known) return known;
    if (!deps.beneficiaries) return deps.defaultBeneficiaryId;
    const listed = await deps.beneficiaries.listBeneficiaries();
    const found = listed.find((b) => b.nickname === supplier.payee.nickname) ?? (await deps.beneficiaries.createBeneficiary(supplier.payee));
    payees.set(supplier.id, found.id);
    return found.id;
  }

  /** The next invoice number for a supplier: its base, plus one for every invoice it already sent on this ledger. */
  function nextReference(supplier: Supplier): string {
    const sent = ledger.supplierRequests({ cleared: true }).filter((r) => r.supplierId === supplier.id && r.status !== "DUPLICATE").length;
    const taken = new Set(ledger.listObligations().map((o) => o.reference));
    let n = supplier.invoiceBase + sent;
    while (taken.has(`${supplier.invoicePrefix}-${n}`)) n++;
    return `${supplier.invoicePrefix}-${n}`;
  }

  const card = (s: Supplier): SupplierCard => ({
    ...badgeOf(s), bills: s.bills, domain: s.domain, nextReference: nextReference(s), dueInDays: s.dueInDays, amountMinor: invoiceTotal(s), currency: "USD",
    lines: s.lines, story: STORIES[s.story],
  });

  const requestView = (r: SupplierRequest): SupplierRequestView => {
    const supplier = supplierById(r.supplierId);
    return {
      ...r,
      supplier: supplier ? badgeOf(supplier) : { id: r.supplierId, name: r.supplierId, legalName: r.supplierId, tile: { bg: "#111111", fg: "#ffffff" } },
      story: r.story && r.story in STORIES ? STORIES[r.story as StoryId] : null,
    };
  };

  /** Files a request as it arrived and judges it at the door. A copy of an invoice on the ledger is filed with it. */
  function receive(
    supplier: Supplier,
    message: { from: string; subject: string; body: string },
    reference: string,
    amountMinor: number,
    story: StoryId | null = supplier.story,
  ): SupplierRequest {
    const existing = ledger.listObligations().find((o) => o.reference === reference) ?? null;
    const judged = checkIntake(
      { sender: message.from, subject: message.subject, body: message.body, reference, amountMinor, currency: "USD" },
      { vendor: supplier, existing: existing ? { id: existing.id, status: existing.status } : null, maxAmountMinor: deps.maxAmount * 100 },
    );
    return ledger.tx(() => {
      const filed = ledger.addSupplierRequest({
        supplierId: supplier.id, story, reference, amountMinor, currency: "USD", sender: message.from, subject: message.subject,
        body: message.body, verdict: judged.verdict, checks: judged.checks, summary: judged.summary, duplicateOf: existing?.id ?? null,
      });
      if (existing && judged.verdict === "DUPLICATE") ledger.addInboxMessage({ incidentId: existing.id, from: message.from, email: `Subject: ${message.subject}\n\n${message.body}` });
      return filed;
    });
  }

  /** Rehearsal: the supplier sends the invoice it has ready. */
  function send(supplier: Supplier): SupplierRequest {
    const reference = nextReference(supplier);
    const amountMinor = invoiceTotal(supplier);
    const values = { ref: reference, amount: formatMinor(amountMinor, "USD"), due: dueDate(new Date(), supplier.dueInDays) };
    return receive(supplier, { from: supplier.request.from, subject: fill(supplier.request.subject, values), body: fill(supplier.request.body, values) }, reference, amountMinor);
  }

  /** Tries `fn` a few times: the sandbox refuses a status change while the transfer is mid-update. */
  async function patiently(fn: () => Promise<void>, tries = 5): Promise<void> {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i >= tries) throw error;
        await Bun.sleep(pollMs * 1.5);
      }
    }
  }

  /** A person approved the request: open the invoice and pay the supplier's account on file. */
  async function approve(requestId: string, note: string): Promise<string> {
    const request = ledger.requireSupplierRequest(requestId);
    const supplier = supplierById(request.supplierId);
    if (!supplier) throw new StateConflict(`no supplier ${request.supplierId} on file`);
    if (request.status !== "RECEIVED") throw new StateConflict(`${request.reference} is ${request.status.toLowerCase()}: only a request that passed every check can be approved`);
    // Judged again at the moment of approval: an invoice opened since it arrived makes this one a copy.
    const existing = ledger.listObligations().find((o) => o.reference === request.reference) ?? null;
    if (existing) throw new StateConflict(`${request.reference} is already on the ledger; this request cannot open it again`);
    const beneficiaryId = await payeeFor(supplier);
    const obligation = ledger.openFromRequest(requestId, {
      reference: request.reference, beneficiaryId, amountMinor: request.amountMinor, currency: request.currency, method: "LOCAL",
      reason: "professional_business_services",
    }, deps.operator, note);
    const { evidenceHash } = await commander.assess(obligation.id);
    const approval = await commander.humanApproval({ obligationId: obligation.id, approver: deps.operator, note, evidenceHash });
    const { attempt } = await gateway.submit(approval);
    // The bank accepts it straight away, so the story (not the bank clock) decides what happens next.
    if (deps.simulator && attempt.transferId && request.story) {
      const simulator = deps.simulator;
      await patiently(() => simulator.advance(attempt.transferId!, "SENT")).catch(() => undefined);
      await gateway.sync(obligation.id).catch(() => undefined);
      await deps.reactor?.react({ source: "setup" }).catch(() => undefined);
    }
    return obligation.id;
  }

  /**
   * This morning (src/demo/morning.ts): each supplier's invoice arrived, passed the door, was approved by a person and
   * paid, all through the ordinary path; then the bank moves each transfer to where it stands this morning, the
   * supplier's messages arrive, and the case opens. History, not news: no agent is woken by any of it.
   */
  async function morning(): Promise<MorningResult> {
    const simulator = deps.simulator;
    if (!simulator) throw new Forbidden("supplier issues can be opened only in an offline sandbox or on the Airwallex sandbox");
    const note = "Scheduled payment run: checked against the vendor record and the invoice.";
    const setUp = async () => {
      const opened: Array<{ c: MorningCase; supplier: Supplier; obligation: Obligation; values: { ref: string; amount: string; due: string } }> = [];
      // The last payment run: the invoice arrives, the door checks it, a person approves it and Tessera pays it. The bank
      // then moves the transfer to where it stands this morning, straight away, before the bank clock could take it for
      // an untouched one and pay it.
      for (const c of MORNING) {
        const supplier = morningSupplier(c);
        const reference = nextReference(supplier);
        const amountMinor = invoiceTotal(supplier);
        const values = { ref: reference, amount: formatMinor(amountMinor, "USD"), due: dueDate(new Date(), -1) };
        const invoice = c.invoice ?? supplier.request;
        const request = receive(supplier, { from: invoice.from, subject: fill(invoice.subject, values), body: fill(invoice.body, values) }, reference, amountMinor, null);
        if (request.status !== "RECEIVED") throw new StateConflict(`${supplier.name}'s invoice did not pass the door: ${request.summary}`);
        const beneficiaryId = await payeeFor(supplier);
        const obligation = ledger.openFromRequest(request.id, {
          reference, beneficiaryId, amountMinor, currency: "USD", method: "LOCAL", reason: "professional_business_services",
        }, deps.operator, note, { fileEmail: false });
        const { evidenceHash } = await commander.assess(obligation.id);
        await gateway.submit(await commander.humanApproval({ obligationId: obligation.id, approver: deps.operator, note, evidenceHash }));
        opened.push({ c, supplier, obligation, values });
        const transferId = ledger.latestAttempt(obligation.id)?.transferId;
        if (!transferId) throw new StateConflict(`${obligation.reference} has no transfer at Airwallex`);
        const bank = c.bank;
        await patiently(() => simulator.advance(transferId, "SENT"));
        if (bank.status === "FAILED") await patiently(() => simulator.advance(transferId, "FAILED", bank.failureType));
        if (bank.status === "PAID") await patiently(() => simulator.advance(transferId, "PAID"));
        await gateway.sync(obligation.id);
      }
      // A failed transfer is cancelled by Airwallex a moment later; only then is the money back in the wallet. The
      // sandbox does not always do it (a 91301 return has sat at FAILED for minutes), so a transfer still FAILED after a
      // few polls is moved on through the simulator: the step the bank would have taken, and nothing a case relies on.
      const failing = opened.filter(({ c }) => c.bank.status === "FAILED").map(({ obligation }) => obligation);
      const nudged = new Set<string>();
      for (let i = 0; i < 45 && failing.some((o) => ledger.latestAttempt(o.id)?.state !== "DEAD"); i++) {
        if (i > 0) await Bun.sleep(pollMs);
        for (const o of failing) {
          const attempt = ledger.latestAttempt(o.id);
          if (attempt?.state === "DEAD") continue;
          if (i >= CANCEL_AFTER_POLLS && attempt?.awxStatus === "FAILED" && attempt.transferId && !nudged.has(o.id)) {
            nudged.add(o.id);
            // Refused if Airwallex cancelled it in between: the sync below sees that either way.
            await simulator.advance(attempt.transferId, "CANCELLED").catch(() => undefined);
          }
          await gateway.sync(o.id);
        }
      }
      const stuck = failing.filter((o) => ledger.latestAttempt(o.id)?.state !== "DEAD");
      if (stuck.length > 0) throw new StateConflict(`Airwallex has not cancelled ${stuck.map((o) => o.reference).join(", ")} yet; try again in a moment`);
      // This morning: what the suppliers sent, and the case each one opens.
      for (const { c, supplier, obligation, values } of opened) {
        const named = { ref: values.ref, amount: values.amount, who: supplier.name };
        ledger.tx(() => {
          if (c.chase) {
            ledger.addInboxMessage({
              incidentId: obligation.id, from: c.chase.from, email: `Subject: ${fill(c.chase.subject, values)}\n\n${fill(c.chase.body, values)}`,
              ...(c.chase.statementText ? { statementText: c.chase.statementText } : {}),
            });
          }
          const brief: CaseOpened = {
            kind: c.kind, supplierId: supplier.id, lands: c.lands === true, by: deps.operator,
            problem: { headline: fillCase(c.problem.headline, named), detail: fillCase(c.problem.detail, named) },
          };
          ledger.append(obligation.id, "CASE_OPENED", brief);
        });
      }
      return opened;
    };
    const opened = await (simulator.withoutEvents ? simulator.withoutEvents(setUp) : setUp());
    // Their transfer changes are recorded as reacted to, so the sweep does not later mistake them for news.
    await deps.reactor?.react({ source: "setup" }).catch(() => undefined);
    return { cases: opened.map(({ supplier, obligation }) => ({ id: obligation.id, reference: obligation.reference, supplier: supplier.name })) };
  }

  /** The story of an invoice opened from a request, or null. */
  function storyFor(obligationId: string): Story | null {
    const request = ledger.requestForObligation(obligationId);
    const supplier = request ? supplierById(request.supplierId) : undefined;
    if (!request?.story || !supplier || !(request.story in STORIES)) return null;
    const story = request.story as StoryId;
    const steps = storySteps(supplier, story, stateOf(obligationId));
    return { supplier: badgeOf(supplier), story: STORIES[story], playable: deps.simulator !== null, steps };
  }

  const stateOf = (obligationId: string) => ({
    obligation: ledger.requireObligation(obligationId),
    attempts: ledger.attemptsFor(obligationId),
    events: ledger.events(obligationId),
    hasCard: ledger.invoiceCard(obligationId) !== null,
    card: cardOf(obligationId),
  });

  /** The card holding the invoice's lock, as the story reads it (a declined or refused card leaves the transfer path). */
  const cardOf = (obligationId: string) => {
    const card = ledger.invoiceCard(obligationId);
    return card ? { state: card.state, spentMinor: card.spentMinor, settled: ledger.cardSettlements(card.id).length > 0 } : null;
  };

  /** Plays the supplier's or the bank's next move, and chains it. */
  async function play(obligationId: string, stepId: string): Promise<void> {
    const simulator = deps.simulator;
    if (!simulator) throw new Forbidden("the supplier's and the bank's parts can be played only on the sandbox or offline");
    const request = ledger.requestForObligation(obligationId);
    const supplier = request ? supplierById(request.supplierId) : undefined;
    if (!request?.story || !supplier) throw new StateConflict("this invoice has no story to play");
    const story = request.story as StoryId;
    const effect = effectFor(supplier, story, stateOf(obligationId), stepId);
    if (typeof effect === "string") throw new StateConflict(effect);
    const o = ledger.requireObligation(obligationId);
    const latest = ledger.attemptsFor(obligationId).at(-1);

    switch (effect.kind) {
      case "message": {
        const message = followUpFor(supplier, o, new Date(request.receivedAt));
        if (!message) throw new StateConflict(`${supplier.name} has nothing more to say`);
        ledger.tx(() => {
          ledger.addInboxMessage({ incidentId: obligationId, from: message.from, email: message.email, ...(message.statementText ? { statementText: message.statementText } : {}) });
          ledger.append(obligationId, "STORY_STEP", { story, step: stepId, actor: "supplier", by: deps.operator });
        });
        return;
      }
      case "resend": {
        const f = supplier.followUp;
        if (!f) throw new StateConflict(`${supplier.name} has nothing to send again`);
        const values = { ref: o.reference, amount: formatMinor(o.amountMinor, o.currency), due: dueDate(new Date(request.receivedAt), supplier.dueInDays) };
        ledger.tx(() => {
          receive(supplier, { from: f.from, subject: fill(f.subject, values), body: fill(f.body, values) }, o.reference, o.amountMinor);
          ledger.append(obligationId, "STORY_STEP", { story, step: stepId, actor: "supplier", by: deps.operator });
        });
        return;
      }
      case "fail": {
        if (!latest?.transferId) throw new StateConflict("there is no transfer for the bank to fail");
        await patiently(() => simulator.advance(latest.transferId!, "FAILED", effect.failureType));
        ledger.append(obligationId, "STORY_STEP", { story, step: stepId, actor: "bank", failureType: effect.failureType, by: deps.operator });
        // Airwallex cancels a failed transfer a moment later; read it back until it has, so the page shows the bank's answer.
        for (let i = 0; i < 12; i++) {
          await gateway.sync(obligationId).catch(() => undefined);
          if (ledger.attemptsFor(obligationId).at(-1)?.state === "DEAD") break;
          await Bun.sleep(pollMs);
        }
        await deps.reactor?.react({ source: "sweep" }).catch(() => undefined);
        return;
      }
      case "pay": {
        if (!latest?.transferId) throw new StateConflict("there is no transfer for the bank to pay");
        if (latest.awxStatus !== "SENT") await patiently(() => simulator.advance(latest.transferId!, "SENT")).catch(() => undefined);
        await patiently(() => simulator.advance(latest.transferId!, "PAID"));
        ledger.append(obligationId, "STORY_STEP", { story, step: stepId, actor: "bank", by: deps.operator });
        await gateway.sync(obligationId).catch(() => undefined);
        await deps.reactor?.react({ source: "sweep" }).catch(() => undefined);
        return;
      }
    }
  }

  async function route(request: Request, path: string, read: <S extends z.ZodType>(r: Request, schema: S) => Promise<z.infer<S>>): Promise<Response | null> {
    if (path === "/api/suppliers" && request.method === "GET") {
      const body: Suppliers = { rehearsal: deps.simulator !== null, suppliers: SUPPLIERS.map(card) };
      return json(body);
    }
    if (path === "/api/requests") {
      if (request.method === "GET") return json({ items: ledger.supplierRequests().map(requestView) });
      if (request.method === "POST") {
        if (!deps.simulator) return json({ error: "Forbidden", message: "suppliers can be asked to send invoices only on the sandbox or offline" }, 403);
        const { supplierId } = await read(request, SendBody);
        const supplier = supplierById(supplierId);
        if (!supplier) return json({ error: "NotFound", message: `no supplier ${supplierId} on file` }, 404);
        return json(requestView(send(supplier)), 201);
      }
      return json({ error: "MethodNotAllowed", message: "unsupported method" }, 405);
    }
    const match = path.match(/^\/api\/requests\/([\w-]+)\/(approve|decline|clear)$/);
    if (match) {
      if (request.method !== "POST") return json({ error: "MethodNotAllowed", message: "unsupported method" }, 405);
      const [, id, action] = match as unknown as [string, string, string];
      if (!ledger.getSupplierRequest(id)) return json({ error: "NotFound", message: "no such request" }, 404);
      if (action === "clear") return json(requestView(ledger.clearSupplierRequest(id)));
      const { note } = await read(request, NoteBody);
      if (action === "approve") return json({ obligationId: await approve(id, note) }, 201);
      return json(requestView(ledger.declineRequest(id, deps.operator, note)));
    }
    return null;
  }

  return { route, storyFor, play, morning, badgeFor: (obligationId: string): SupplierBadge | null => {
    const r = ledger.requestForObligation(obligationId);
    const s = r ? supplierById(r.supplierId) : undefined;
    return s ? badgeOf(s) : null;
  } };
}

export class Forbidden extends Error {}

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });
