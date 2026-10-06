/**
 * Kill -9 chaos test against the real sandbox.
 *   bun run chaos            both scenarios
 *   bun run chaos after      kill after Airwallex created the transfer but before the ledger recorded it
 *   bun run chaos before     kill before the create request leaves the process
 * A child process pays an obligation and is SIGKILLed mid-create. The parent restarts from the ledger file and
 * must end with exactly one transfer at Airwallex and a second payment refused.
 */
import { mkdirSync, rmSync } from "node:fs";
import { AirwallexClient } from "../src/airwallex/client";
import type { CreateTransferRequest, PayoutApi, Transfer } from "../src/airwallex/types";
import { issueApproval, newNonce, type Approval } from "../src/approval/approval";
import { DuplicateLockError } from "../src/errors";
import { PayoutGateway } from "../src/gateway/gateway";
import { Ledger } from "../src/ledger/ledger";

type KillPoint = "before" | "after";

const secret = process.env.PAYONCE_APPROVAL_SECRET;
if (!secret) throw new Error("PAYONCE_APPROVAL_SECRET is not set");
const client = AirwallexClient.fromEnv();

/** Delegates to Airwallex, but takes the whole process down at the chosen moment. */
class SelfDestructingApi implements PayoutApi {
  constructor(private readonly when: KillPoint) {}

  async createTransfer(request: CreateTransferRequest): Promise<Transfer> {
    if (this.when === "before") process.kill(process.pid, "SIGKILL");
    await client.createTransfer(request);
    process.kill(process.pid, "SIGKILL");
    await Bun.sleep(60_000);
    throw new Error("unreachable: process should be dead");
  }
  getTransfer(id: string): Promise<Transfer> {
    return client.getTransfer(id);
  }
  findTransferByRequestId(requestId: string): Promise<Transfer | null> {
    return client.findTransferByRequestId(requestId);
  }
}

const [, , first, second, third] = process.argv;

if (first === "--child") {
  const when = second as KillPoint;
  const ledger = new Ledger(third!);
  const gateway = new PayoutGateway({ ledger, api: new SelfDestructingApi(when), approvalSecret: secret });
  await gateway.submit(JSON.parse(process.argv[5]!) as Approval);
  console.log("child survived (unexpected)");
  process.exit(2);
}

async function scenario(when: KillPoint): Promise<boolean> {
  const db = `.data/chaos-${when}.db`;
  mkdirSync(".data", { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(db + suffix, { force: true });

  const beneficiaryId = (await client.listBeneficiaries()).find((b) => b.nickname === "spike-us-supplier")?.id;
  if (!beneficiaryId) throw new Error("no spike-us-supplier beneficiary in the sandbox");

  const ledger = new Ledger(db);
  const obligation = ledger.createObligation({
    reference: `CHAOS-${when.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`,
    beneficiaryId,
    amountMinor: 1_000,
    currency: "USD",
    method: "LOCAL",
    reason: "professional_business_services",
  });
  const approve = (): Approval =>
    issueApproval(
      {
        obligationId: obligation.id,
        amountMinor: obligation.amountMinor,
        currency: obligation.currency,
        beneficiaryId,
        method: "LOCAL",
        reason: obligation.reason,
        replacesAttemptId: null,
        evidenceHash: "0".repeat(64),
        mode: "POLICY",
        approver: "policy:chaos",
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        nonce: newNonce(),
      },
      secret!,
    );
  const approval = approve();
  ledger.close();

  const label: Record<KillPoint, string> = {
    after: "SIGKILL after Airwallex created the transfer, before the ledger recorded it",
    before: "SIGKILL before the create request leaves the process",
  };
  console.log(`\n== ${label[when]} (${obligation.reference})`);
  const child = Bun.spawn([process.execPath, import.meta.path, "--child", when, db, JSON.stringify(approval)], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await child.exited;
  console.log(`   child died: signal=${child.signalCode} exit=${child.exitCode}`);

  const reopened = new Ledger(db);
  const gateway = new PayoutGateway({ ledger: reopened, api: client, approvalSecret: secret! });
  const stuck = reopened.latestAttempt(obligation.id)!;
  const landed = await client.findTransferByRequestId(stuck.requestId);
  console.log(`   ledger after crash:   attempt ${stuck.state}, transferId=${stuck.transferId ?? "none"}`);
  console.log(`   airwallex has it?     ${landed ? `yes (${landed.id})` : "no"}`);

  let refused = false;
  try {
    await gateway.submit(issueApproval({ ...approval.payload, nonce: newNonce() }, secret!));
  } catch (error) {
    refused = error instanceof DuplicateLockError;
  }
  console.log(`   second payment:       ${refused ? "refused by the lock" : "NOT REFUSED"}`);

  const [recovered] = await gateway.recover();
  console.log(`   recover():            ${recovered?.outcome}, attempt ${recovered?.attempt.state}`);
  const rerun = await gateway.recover();
  console.log(`   recover() again:      ${rerun.length} attempts to resolve`);

  const recent = await client.listTransfers(new Date(Date.now() - 30 * 60_000).toISOString());
  const copies = recent.filter((t) => t.reference === obligation.reference);
  console.log(`   transfers for ${obligation.reference}: ${copies.length}`);

  const final = reopened.latestAttempt(obligation.id)!;
  const ok =
    child.signalCode === "SIGKILL" &&
    refused &&
    copies.length === 1 &&
    final.transferId === copies[0]!.id &&
    final.requestId === stuck.requestId &&
    rerun.length === 0 &&
    reopened.verifyChain().ok;
  console.log(`   RESULT: ${ok ? "PASS exactly one transfer, same request_id, chain intact" : "FAIL"}`);
  reopened.close();
  return ok;
}

const requested = first as KillPoint | undefined;
const points: KillPoint[] = requested ? [requested] : ["after", "before"];
let allPassed = true;
for (const point of points) allPassed = (await scenario(point)) && allPassed;
process.exit(allPassed ? 0 : 1);
