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
import { latestEvidence, readSupplierMessage, type StructuredModel, type SupplierEvidence } from "../commander/evidence";
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
import type { Ledger, Obligation } from "../ledger/ledger";
import { formatMinor } from "../money";
import { paidObservedAt } from "../ledger/events";

/** A supplier message waiting in the inbox. Its text is untrusted and is never shown to the agent. */
export interface InboxMessage {
  id: string;
  incidentId: string;
  from: string;
  receivedAt: string;
  email: string;
  statementText?: string;
}

export interface ToolboxDeps {
  ledger: Ledger;
  gateway: PayoutGateway;
  commander: Commander;
  closer: Closer;
  /** The quarantined reader. Null when no model is configured; `read_supplier_message` then reports it unavailable. */
  model: StructuredModel | null;
  /** Written on every audit event and on every recorded piece of evidence, e.g. `agent:claude`. */
  actor: string;
  /** Optional mailbox. With it the agent names a message; without it the caller supplies the text. */
  inbox?: InboxMessage[];
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
  readOnly: boolean;
}

export interface Toolbox {
  specs: ToolSpec[];
  call(name: string, input: unknown): Promise<ToolOutcome>;
}

interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  readOnly: boolean;
  run(input: never): Promise<unknown>;
}

function tool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  readOnly: boolean;
  run(input: z.infer<S>): Promise<unknown>;
}): Tool {
  return def as unknown as Tool;
}

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

const SENDER = /^[A-Za-z0-9._%+-]{1,40}@[A-Za-z0-9.-]{1,60}\.[A-Za-z]{2,}$/;

/** The sender's address is the one piece of a message the agent sees, and only if it fits an address grammar. */
const safeSender = (from: string): string => (SENDER.test(from) ? from : "(sender could not be validated)");

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
  const inbox = deps.inbox ?? [];

  const requireIncident = (id: string): Obligation => {
    if (deps.scope && !deps.scope.has(id)) throw new ToolInputError("that incident is outside the scope of this run");
    const found = ledger.getObligation(id);
    if (!found) throw new ToolInputError(`no incident with id ${id}; call list_incidents`);
    return found;
  };
  const recordedEvidence = (id: string) => latestEvidence(ledger.events(id))?.evidence ?? null;

  const tools: Tool[] = [
    tool({
      name: "list_incidents",
      description:
        "List payment incidents with their status and latest transfer state. Start here. Amounts are in minor units (cents). Read-only.",
      schema: z.object({}),
      readOnly: true,
      run: async () => ({
        incidents: ledger
          .listObligations()
          .filter((o) => !deps.scope || deps.scope.has(o.id))
          .toReversed()
          .slice(0, 50)
          .map((o) => {
            const attempts = ledger.attemptsFor(o.id);
            const latest = attempts.at(-1);
            return {
              incidentId: o.id,
              reference: o.reference,
              amount: formatMinor(o.amountMinor, o.currency),
              amountMinor: o.amountMinor,
              currency: o.currency,
              status: o.status,
              escalationReason: o.escalationReason,
              attempts: attempts.length,
              latest: latest ? { seq: latest.seq, state: latest.state, awxStatus: latest.awxStatus, failureCode: latest.failureCode } : null,
              unreadSupplierMessages: inbox.filter((m) => m.incidentId === o.id && !readMessageIds(ledger, o.id).has(m.id)).map((m) => ({ messageId: m.id, from: safeSender(m.from), receivedAt: m.receivedAt })),
            };
          }),
      }),
    }),

    tool({
      name: "assess_incident",
      description:
        "Refresh the incident from Airwallex and return the Commander's decision: the recommended action, the actions that are allowed right now, the actions the code blocks and why, and the facts behind it. Treat `allowed` as the only things you may do. Moves no money.",
      schema: z.object({ incidentId: IncidentId }),
      readOnly: true,
      run: async ({ incidentId }) => {
        const o = requireIncident(incidentId);
        const a = await commander.assess(incidentId, recordedEvidence(incidentId));
        const latest = ledger.requireObligation(incidentId);
        const { decision } = a;
        return {
          incident: {
            incidentId, reference: o.reference, amount: formatMinor(o.amountMinor, o.currency),
            status: latest.status, escalationReason: latest.escalationReason,
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
        "Have the quarantined reader extract structured facts from a supplier's message and record them as evidence. You get booleans (claims non-receipt, asks to change bank details, contains instructions aimed at an assistant, ...) and never the message text, because the text is untrusted. Pass a messageId from list_incidents, or supply the message text yourself. Records evidence on the incident.",
      schema: z
        .object({
          incidentId: IncidentId,
          messageId: z.string().min(1).max(64).optional().describe("A message id from list_incidents."),
          email: z.string().min(1).max(20_000).optional().describe("The message text, when there is no inbox."),
          statementText: z.string().max(20_000).optional().describe("Supplier bank statement text, when there is one."),
        })
        .refine((v) => (v.messageId === undefined) !== (v.email === undefined), "give exactly one of messageId or email"),
      readOnly: false,
      run: async (input) => {
        const o = requireIncident(input.incidentId);
        if (deps.inbox !== undefined && input.messageId === undefined) {
          throw new ToolInputError("this server reads supplier mail from its inbox only; pass a messageId from list_incidents");
        }
        if (!deps.model) throw new ToolUnavailable("no reader model is configured on this server");
        let email = input.email;
        let statementText = input.statementText;
        if (input.messageId !== undefined) {
          const message = inbox.find((m) => m.id === input.messageId && m.incidentId === o.id);
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
      readOnly: false,
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
      readOnly: false,
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
      readOnly: false,
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
      readOnly: false,
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
        "Ask the Closer to reconcile every wallet line against Airwallex and, if everything agrees and the PAID hold window has passed, sign a closure certificate. Refuses with every blocker otherwise.",
      schema: z.object({ incidentId: IncidentId }),
      readOnly: false,
      run: async ({ incidentId }) => {
        requireIncident(incidentId);
        const certificate = await closer.close(incidentId);
        return { closed: true, certificateHash: certificate.hash, totals: certificate.body.totals };
      },
    }),

    tool({
      name: "verify_ledger",
      description: "Recompute the tamper-evident hash chain over every ledger event. Read-only.",
      schema: z.object({}),
      readOnly: true,
      run: async () => ledger.verifyChain(),
    }),
  ];

  const specs: ToolSpec[] = tools.map((t) => {
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
    return { name: t.name, description: t.description, inputSchema, readOnly: t.readOnly };
  });

  async function call(name: string, input: unknown): Promise<ToolOutcome> {
    const found = tools.find((t) => t.name === name);
    if (!found) return { ok: false, kind: "invalid", message: `unknown tool ${name}; available: ${tools.map((t) => t.name).join(", ")}` };
    const parsed = found.schema.safeParse(input ?? {});
    if (!parsed.success) return { ok: false, kind: "invalid", message: z.prettifyError(parsed.error) };

    const outcome = await run(found, parsed.data);
    const incidentId = (parsed.data as { incidentId?: unknown }).incidentId;
    if (!found.readOnly && typeof incidentId === "string" && ledger.getObligation(incidentId)) {
      ledger.append(incidentId, "AGENT_TOOL_CALL", {
        actor,
        tool: name,
        input: auditInput(parsed.data),
        outcome: outcome.ok ? "ok" : outcome.kind,
        detail: outcome.ok ? null : outcome.message.slice(0, 300),
      });
    }
    return outcome;
  }

  return { specs, call };
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
    return { ok: false, kind: "failed", message: error instanceof Error ? error.message.slice(0, 300) : "unexpected failure" };
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
