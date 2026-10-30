/**
 * The capability boundary for any agent that works an incident: nine typed tools, and nothing else.
 *
 * What is missing is the point. There is no tool that creates a transfer, signs an approval, changes an amount or a
 * beneficiary, or releases a payment a policy forbids. An agent can read, record what a supplier said, defer, hand an
 * incident to a person, draft a reply for a person to send, ask for an automatic replacement the code will only grant
 * when it is provably safe, and ask the Closer to certify. Every refusal comes from the same code a human hits, and every call is written to the
 * hash-chained ledger.
 *
 * The same toolbox backs the in-process Claude loop (`loop.ts`) and the MCP server (`mcp.ts`).
 */
import { z } from "zod";
import { sha256Hex } from "../canonical";
import type { Closer } from "../closer/closer";
import type { Commander } from "../commander/commander";
import { DRAFT_ACTION, DRAFT_KINDS, checkDraftText } from "../commander/drafts";
import { effectiveEvidence, readSupplierMessage, type StructuredModel, type SupplierEvidence } from "../commander/evidence";
import {
  ApprovalRejected,
  AutoReplacementRefused,
  DraftRejected,
  DuplicateLockError,
  LedgerMismatchError,
  NotClosable,
  ObligationNotPayable,
  ReplacementDenied,
} from "../errors";
import type { PayoutGateway } from "../gateway/gateway";
import type { InboxMessage, Ledger, Obligation } from "../ledger/ledger";
import { formatMinor } from "../money";
import { paidObservedAt } from "../ledger/events";

export interface ToolboxDeps {
  ledger: Ledger;
  gateway: PayoutGateway;
  commander: Commander;
  closer: Closer;
  /** The quarantined reader. Null when no model is configured; `read_supplier_message` then reports it unavailable. */
  model: StructuredModel | null;
  /** Written on every audit event and on every recorded piece of evidence, e.g. `agent:claude`. */
  actor: string;
  /**
   * Whether the caller may hand `read_supplier_message` message text of its own. True only for MCP, where the client
   * is the operator's own assistant. Otherwise the agent may only name a message already in the ledger inbox.
   */
  acceptClientText: boolean;
  /** `triage` can read, record, defer, draft and escalate; it is never offered replace_payment or reconcile_and_close. */
  authority?: "operator" | "triage";
  /** Hard limit on which incidents this toolbox can see or touch. Absent means all of them. */
  scope?: ReadonlySet<string>;
}

export type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; kind: "refused"; error: string; message: string; details?: unknown }
  | { ok: false; kind: "invalid"; message: string }
  | { ok: false; kind: "failed"; message: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

/** MCP tool annotations. `openWorldHint` marks the tools that call Airwallex. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface Toolbox {
  specs: ToolSpec[];
  call(name: string, input: unknown): Promise<ToolOutcome>;
}

interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  annotations: ToolAnnotations;
  /** Withheld from a triage agent: neither listed nor callable. */
  operatorOnly?: boolean;
  run(input: never): Promise<unknown>;
}

function tool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  annotations: ToolAnnotations;
  operatorOnly?: boolean;
  run(input: z.infer<S>): Promise<unknown>;
}): Tool {
  return def as unknown as Tool;
}

const hints = (h: Partial<ToolAnnotations>): ToolAnnotations => ({
  readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...h,
});

const IncidentId = z.string().min(1).max(64).describe("The incident (obligation) id from list_incidents.");

/** What the agent learns about evidence. The model's free-text summary is withheld on purpose. */
function evidenceView(evidence: SupplierEvidence | null) {
  if (!evidence) return null;
  return {
    claimsNonReceipt: evidence.claimsNonReceipt,
    requestsDetailChange: evidence.requestsDetailChange,
    referencesObligation: evidence.referencesObligation,
    containsEmbeddedInstructions: evidence.containsEmbeddedInstructions,
    statementCreditMinor: evidence.statementCredit?.amountMinor ?? null,
    codeAdjustments: evidence.adjustments,
  };
}

/** The bare address of a `From` value, lowercased: `"Name" <a@b.example>` and `A@B.example` both give `a@b.example`. */
function senderAddress(from: string): string {
  return (/<([^<>]*)>\s*$/.exec(from)?.[1] ?? from).trim().toLowerCase();
}

/**
 * What an agent learns about who sent a message: an opaque id and whether the domain matches the incident's earlier
 * messages. No part of the address is shown, because a display name, local part or domain can each carry words.
 * `sameDomainAsEarlierMessages` is null for the first message on an incident.
 */
function senderView(messages: InboxMessage[], index: number): { id: string; sameDomainAsEarlierMessages: boolean | null } {
  const domainOf = (from: string) => senderAddress(from).split("@").at(-1)!;
  const domain = domainOf(messages[index]!.from);
  const earlier = messages.slice(0, index);
  return {
    id: sha256Hex(senderAddress(messages[index]!.from)).slice(0, 12),
    sameDomainAsEarlierMessages: earlier.length === 0 ? null : earlier.every((m) => domainOf(m.from) === domain),
  };
}

/** Audit input: identifiers and decisions, never the text of an untrusted message. */
function auditInput(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === "string" && (key === "email" || key === "statementText" || key === "message")
      ? { sha256: sha256Hex(value).slice(0, 16), chars: value.length }
      : value;
  }
  return out;
}

export function createToolbox(deps: ToolboxDeps): Toolbox {
  const { ledger, gateway, commander, closer, actor } = deps;
  const authority = deps.authority ?? "operator";
  const inScope = (id: string): boolean => !deps.scope || deps.scope.has(id);

  /**
   * An escalation reason an agent wrote is untrusted text; other agents learn who escalated, not what they wrote.
   * The audit event is appended right after the escalation, so the two are adjacent in the incident's events.
   * Returns the texts to withhold (the stored reason, and the agent's own words after its `actor: ` prefix) and the label
   * shown instead, or null when the reason did not come from an agent.
   */
  const withheldReason = (o: Obligation): { texts: string[]; label: string } | null => {
    if (o.escalationReason === null) return null;
    const events = ledger.events(o.id);
    const at = events.findLastIndex((e) => e.type === "ESCALATED");
    const audit = events[at + 1];
    const payload = audit?.payload as { actor?: unknown; tool?: unknown } | null | undefined;
    if (at < 0 || audit?.type !== "AGENT_TOOL_CALL" || payload?.tool !== "escalate_to_human") return null;
    const prefix = `${String(payload.actor)}: `;
    const own = o.escalationReason.startsWith(prefix) ? o.escalationReason.slice(prefix.length) : "";
    return {
      texts: [o.escalationReason, ...(own.trim() ? [own] : [])],
      label: `escalated by ${String(payload.actor)} (reason withheld: sha256 ${sha256Hex(o.escalationReason).slice(0, 16)})`,
    };
  };
  const escalationView = (o: Obligation): string | null => withheldReason(o)?.label ?? o.escalationReason;

  /**
   * Policy reasons and refusals quote the escalation reason too, so every string a call returns is scrubbed of any
   * withheld reason for the incidents it touched (all in-scope incidents when it names none).
   */
  const scrub = (outcome: ToolOutcome, incidentId: unknown): ToolOutcome => {
    const touched = typeof incidentId === "string"
      ? [ledger.getObligation(incidentId)].filter((o): o is Obligation => o !== null && inScope(o.id))
      : ledger.listObligations().filter((o) => inScope(o.id));
    const swaps = touched
      .flatMap((o) => { const w = withheldReason(o); return w ? w.texts.map((text) => [text, w.label] as const) : []; })
      .toSorted((a, b) => b[0].length - a[0].length);
    return swaps.length === 0 ? outcome : (replaceStrings(outcome, swaps) as ToolOutcome);
  };

  const requireIncident = (id: string): Obligation => {
    if (!inScope(id)) throw new ToolInputError("that incident is outside the scope of this run");
    const found = ledger.getObligation(id);
    if (!found) throw new ToolInputError(`no incident with id ${id}; call list_incidents`);
    return found;
  };
  const recordedEvidence = (id: string) => effectiveEvidence(ledger.events(id), ledger.requireObligation(id).amountMinor)?.evidence ?? null;

  const tools: Tool[] = [
    tool({
      name: "list_incidents",
      description:
        "List payment incidents with their status and latest transfer state. Start here. Amounts are in minor units (cents). Read-only.",
      schema: z.object({
        includeClosed: z.boolean().optional().describe("Also list CLOSED incidents. Default false: open work only."),
      }),
      annotations: hints({ readOnlyHint: true, idempotentHint: true }),
      run: async ({ includeClosed }) => ({
        incidents: ledger
          .listObligations()
          .filter((o) => inScope(o.id) && (includeClosed === true || o.status !== "CLOSED"))
          .toReversed()
          .slice(0, 50)
          .map((o) => {
            const read = readMessageIds(ledger, o.id);
            const attempts = ledger.attemptsFor(o.id);
            const latest = attempts.at(-1);
            return {
              incidentId: o.id,
              reference: o.reference,
              amount: formatMinor(o.amountMinor, o.currency),
              amountMinor: o.amountMinor,
              currency: o.currency,
              status: o.status,
              escalationReason: escalationView(o),
              attempts: attempts.length,
              latest: latest ? { seq: latest.seq, state: latest.state, awxStatus: latest.awxStatus, failureCode: latest.failureCode } : null,
              unreadSupplierMessages: ledger.inboxMessages(o.id).flatMap((m, i, all) =>
                read.has(m.id) ? [] : [{ messageId: m.id, sender: senderView(all, i), receivedAt: m.receivedAt }]),
            };
          }),
      }),
    }),

    tool({
      name: "assess_incident",
      description:
        "Refresh the incident from Airwallex and return the Commander's decision: the recommended action, the actions that are allowed right now, the actions the code blocks and why, and the facts behind it. Treat `allowed` as the only things you may do. Moves no money.",
      schema: z.object({ incidentId: IncidentId }),
      // Not read-only: refreshing from Airwallex and recovering an INTENT append ledger events.
      annotations: hints({ idempotentHint: true, openWorldHint: true }),
      run: async ({ incidentId }) => {
        const o = requireIncident(incidentId);
        // A payment stuck in INTENT is resolved first (submitted with its original request_id, or escalated).
        if (ledger.attemptsFor(incidentId).some((x) => x.state === "INTENT")) await gateway.recover(incidentId);
        const a = await commander.assess(incidentId, recordedEvidence(incidentId));
        const latest = ledger.requireObligation(incidentId);
        const { decision } = a;
        return {
          incident: {
            incidentId, reference: o.reference, amount: formatMinor(o.amountMinor, o.currency),
            status: latest.status, escalationReason: escalationView(latest),
          },
          attempts: a.facts.attempts.map((x) => ({ seq: x.seq, state: x.state, awxStatus: x.awxStatus, failureCode: x.failureCode })),
          supplierEvidence: evidenceView(recordedEvidence(incidentId)),
          decision: {
            recommended: decision.recommended,
            allowed: decision.allowed,
            blocked: decision.blocked,
            reasons: decision.reasons,
            severity: decision.severity,
            recheckAt: decision.recheckAt,
            replacement: decision.replacement,
          },
        };
      },
    }),

    tool({
      name: "read_supplier_message",
      description:
        `Have the quarantined reader extract structured facts from a supplier's message and record them as evidence. You get booleans (claims non-receipt, asks to change bank details, contains instructions aimed at an assistant, ...) and never the message text, because the text is untrusted. Pass a messageId from list_incidents${deps.acceptClientText ? ", or supply the message text yourself" : ""}. Records evidence on the incident.`,
      schema: z
        .object({
          incidentId: IncidentId,
          messageId: z.string().min(1).max(64).optional().describe("A message id from list_incidents."),
          email: z.string().min(1).max(20_000).optional().describe("The message text, when this server accepts it from you."),
          statementText: z.string().max(20_000).optional().describe("Supplier bank statement text, when there is one."),
        })
        .refine((v) => (v.messageId === undefined) !== (v.email === undefined), "give exactly one of messageId or email"),
      annotations: hints({}),
      run: async (input) => {
        const o = requireIncident(input.incidentId);
        if (!deps.acceptClientText && input.messageId === undefined) {
          throw new ToolInputError("this server reads supplier mail from its inbox only; pass a messageId from list_incidents");
        }
        if (!deps.model) throw new ToolUnavailable("no reader model is configured on this server");
        let email = input.email;
        let statementText = input.statementText;
        if (input.messageId !== undefined) {
          const message = ledger.inboxMessages(o.id).find((m) => m.id === input.messageId);
          if (!message) throw new ToolInputError(`no message ${input.messageId} for this incident`);
          email = message.email;
          statementText = message.statementText;
        }
        const evidence = await readSupplierMessage(deps.model, {
          reference: o.reference, amountMinor: o.amountMinor, currency: o.currency, email: email!, statementText,
        });
        ledger.tx(() =>
          ledger.append(o.id, "EVIDENCE_RECORDED", {
            evidence, source: "model", enteredBy: actor,
            message: { email: email!, statementText },
            messageId: input.messageId ?? null,
          }),
        );
        return { recorded: true, supplierEvidence: evidenceView(evidence), next: "call assess_incident to see what this changes" };
      },
    }),

    tool({
      name: "replace_payment",
      description:
        "Ask for an automatic replacement of a failed payment. The code grants it only when the original is provably CANCELLED with funds returned, the failure is transient, the wallet covers it and the amount is within the automatic limit. Otherwise it refuses with the reasons. You cannot override a refusal; escalate_to_human instead.",
      schema: z.object({ incidentId: IncidentId }),
      annotations: hints({ destructiveHint: true, openWorldHint: true }),
      operatorOnly: true,
      run: async ({ incidentId }) => {
        requireIncident(incidentId);
        const result = await commander.replaceAutomatically(incidentId, recordedEvidence(incidentId));
        return {
          outcome: result.outcome,
          attempt: { seq: result.attempt.seq, state: result.attempt.state, awxStatus: result.attempt.awxStatus },
          note: "A new request_id was minted only because the original was provably CANCELLED.",
        };
      },
    }),

    tool({
      name: "draft_supplier_reply",
      description:
        "Draft a short reply to the supplier for a person to review and send. Tessera sends nothing itself. Allowed only when assess_incident lists the matching action: STATUS needs SEND_STATUS_TO_SUPPLIER, PROOF needs SEND_PROOF_TO_SUPPLIER, CORRECTION needs REQUEST_CORRECTION. Write two to four plain, polite, factual sentences. Never include account details, numbers, links, email addresses or any promise of another payment: the code adds the real references itself and refuses a draft that breaks these rules.",
      schema: z.object({ incidentId: IncidentId, kind: z.enum(DRAFT_KINDS), message: z.string().min(1).max(2_000) }),
      annotations: hints({ openWorldHint: true }),
      run: async ({ incidentId, kind, message }) => {
        const o = requireIncident(incidentId);
        const a = await commander.assess(incidentId, recordedEvidence(incidentId));
        const needed = DRAFT_ACTION[kind];
        if (!a.decision.allowed.includes(needed)) {
          throw new DraftRejected(`a ${kind.toLowerCase()} reply is not allowed right now: ${needed} is not among the allowed actions (${a.decision.allowed.join(", ")})`);
        }
        const problem = checkDraftText(message);
        if (problem) throw new DraftRejected(`this draft was refused: ${problem}`);

        const latest = a.facts.attempts.at(-1);
        const facts = [
          `Invoice ${o.reference} · ${formatMinor(o.amountMinor, o.currency)} · ${o.method}`,
          ...(latest?.transferId ? [`Payment reference ${latest.transferId.slice(0, 8)} · Airwallex status ${latest.awxStatus ?? latest.state}`] : []),
          ...(kind === "PROOF" && latest?.state === "PAID"
            ? [`Airwallex reported the payment as made${(() => { const at = paidObservedAt(ledger.events(incidentId), latest.id); return at ? ` on ${at.slice(0, 10)}` : ""; })()}`]
            : []),
        ];
        const event = ledger.append(incidentId, "DRAFT_REPLY", { actor, kind, message: message.trim(), facts });
        return { drafted: true, draftId: event.seq, note: "A person will review it. Nothing has been sent." };
      },
    }),

    tool({
      name: "defer_incident",
      description:
        "Decide to do nothing yet and say why. Use when assess_incident recommends WAIT. Records the decision and when to look again. Moves no money.",
      schema: z.object({ incidentId: IncidentId, note: z.string().min(1).max(300) }),
      annotations: hints({ openWorldHint: true }),
      run: async ({ incidentId, note }) => {
        requireIncident(incidentId);
        const a = await commander.assess(incidentId, recordedEvidence(incidentId));
        ledger.append(incidentId, "AGENT_DEFERRED", { actor, note, recommended: a.decision.recommended, recheckAt: a.decision.recheckAt });
        return { deferred: true, recheckAt: a.decision.recheckAt };
      },
    }),

    tool({
      name: "escalate_to_human",
      description:
        "Hand the incident to a named person with a reason. Always allowed, because it only removes your authority: once escalated, only a person can release a payment. Use for anything you are unsure about, anything involving bank-detail changes, and anything the code blocks.",
      schema: z.object({ incidentId: IncidentId, reason: z.string().min(1).max(300) }),
      annotations: hints({ idempotentHint: true }),
      run: async ({ incidentId, reason }) => {
        const o = requireIncident(incidentId);
        if (o.status === "CLOSED") throw new ToolInputError("this incident is already closed");
        if (o.status !== "ESCALATED") ledger.escalate(incidentId, `${actor}: ${reason.trim().replace(/[.\s]+$/, "")}`);
        return { escalated: true, alreadyEscalated: o.status === "ESCALATED" };
      },
    }),

    tool({
      name: "reconcile_and_close",
      description:
        "Ask the Closer to reconcile every wallet line against Airwallex and, if everything agrees and the PAID hold window has passed, sign a closure certificate. Refused unless the assessment lists CLOSE as allowed, so an open supplier claim of non-receipt, an escalation or an unfinished hold window all block it. Refuses with every blocker.",
      schema: z.object({ incidentId: IncidentId }),
      annotations: hints({ idempotentHint: true, openWorldHint: true }),
      operatorOnly: true,
      run: async ({ incidentId }) => {
        requireIncident(incidentId);
        // The same rule the operator's close route follows: the Commander must allow CLOSE before the Closer is asked.
        await commander.assertCloseAllowed(incidentId, recordedEvidence(incidentId));
        const certificate = await closer.close(incidentId);
        return { closed: true, certificateHash: certificate.hash, totals: certificate.body.totals };
      },
    }),

    tool({
      name: "verify_ledger",
      description: "Recompute the tamper-evident hash chain over every ledger event. Read-only.",
      schema: z.object({}),
      annotations: hints({ readOnlyHint: true, idempotentHint: true }),
      run: async () => ledger.verifyChain(),
    }),
  ].filter((t) => authority === "operator" || !t.operatorOnly);

  const specs: ToolSpec[] = tools.map((t) => {
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
    return { name: t.name, description: t.description, inputSchema, annotations: t.annotations };
  });

  async function call(name: string, input: unknown): Promise<ToolOutcome> {
    const found = tools.find((t) => t.name === name);
    if (!found) return { ok: false, kind: "invalid", message: `unknown tool ${name}; available: ${tools.map((t) => t.name).join(", ")}` };
    const parsed = found.schema.safeParse(input ?? {});
    if (!parsed.success) return { ok: false, kind: "invalid", message: z.prettifyError(parsed.error) };

    const outcome = await run(found, parsed.data);
    const incidentId = (parsed.data as { incidentId?: unknown }).incidentId;
    // Only incidents this run may touch are audited: a refused out-of-scope call leaves no trace on someone else's incident.
    if (!found.annotations.readOnlyHint && typeof incidentId === "string" && inScope(incidentId) && ledger.getObligation(incidentId)) {
      ledger.append(incidentId, "AGENT_TOOL_CALL", {
        actor,
        tool: name,
        input: auditInput(parsed.data),
        outcome: outcome.ok ? "ok" : outcome.kind,
        detail: outcome.ok ? null : outcome.message.slice(0, 300),
      });
    }
    // Scrub first, then truncate: a cut that split a withheld reason would leave a fragment the scrub cannot match.
    const scrubbed = scrub(outcome, incidentId);
    return scrubbed.ok || scrubbed.kind !== "failed" ? scrubbed : { ...scrubbed, message: scrubbed.message.slice(0, 300) };
  }

  return { specs, call };
}

/** Deep copy of `value` with every occurrence of each `from` in every string replaced by its `to`. */
function replaceStrings(value: unknown, swaps: ReadonlyArray<readonly [string, string]>): unknown {
  if (typeof value === "string") return swaps.reduce((text, [from, to]) => text.replaceAll(from, to), value);
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, swaps));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, swaps)]));
  }
  return value;
}

async function run(found: Tool, input: unknown): Promise<ToolOutcome> {
  try {
    return { ok: true, result: await found.run(input as never) };
  } catch (error) {
    if (error instanceof NotClosable) {
      return { ok: false, kind: "refused", error: error.name, message: error.message, details: { blockers: error.blockers } };
    }
    if (error instanceof AutoReplacementRefused) {
      return { ok: false, kind: "refused", error: error.name, message: error.message, details: { reasons: error.decision.reasons } };
    }
    if (
      error instanceof DuplicateLockError || error instanceof ReplacementDenied || error instanceof ApprovalRejected ||
      error instanceof ObligationNotPayable || error instanceof LedgerMismatchError || error instanceof DraftRejected
    ) {
      return { ok: false, kind: "refused", error: error.name, message: error.message };
    }
    if (error instanceof ToolInputError) return { ok: false, kind: "invalid", message: error.message };
    if (error instanceof ToolUnavailable) return { ok: false, kind: "failed", message: error.message };
    console.error("tool failed", error);
    return { ok: false, kind: "failed", message: error instanceof Error ? error.message : "unexpected failure" };
  }
}

class ToolInputError extends Error {}
class ToolUnavailable extends Error {}

/** Inbox messages already read, so the agent is not offered the same message twice. */
function readMessageIds(ledger: Ledger, incidentId: string): Set<string> {
  const ids = new Set<string>();
  for (const event of ledger.events(incidentId)) {
    if (event.type !== "EVIDENCE_RECORDED") continue;
    const id = (event.payload as { messageId?: unknown } | null)?.messageId;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}
