/**
 * Kill -9 chaos test against the real sandbox.
 *   bun run chaos                  every scenario below
 *   bun run chaos after            kill after Airwallex created the transfer but before the ledger recorded it
 *   bun run chaos before           kill before the create request leaves the process
 *   bun run chaos convert          both conversion scenarios
 *   bun run chaos convert-after    kill after Airwallex booked the funding conversion but before the ledger recorded it
 *   bun run chaos convert-before   kill after the conversion intent was committed, before the request leaves
 * A child process pays an obligation (or books the conversion that funds its replacement) and is SIGKILLed mid-create.
 * The parent restarts from the ledger file and must end with exactly one transfer (or conversion) at Airwallex, under
 * the request_id the ledger recorded before the crash, and a second one refused.
 */
import { mkdirSync, rmSync } from "node:fs";
import { AirwallexClient } from "../src/airwallex/client";
import type { Conversion, CreateConversionRequest, CreateTransferRequest, PayoutApi, Transfer } from "../src/airwallex/types";
import { issueApproval, newNonce, type Approval } from "../src/approval/approval";
import { Commander, quoteTerms } from "../src/commander/commander";
import { DEFAULT_POLICY, fundingNeed, type CommanderPolicy } from "../src/commander/policy";
import { seedIncident } from "../src/demo/scenario";
import { DuplicateConversionError, DuplicateLockError } from "../src/errors";
import { issueFundingApproval, type FundingApproval } from "../src/funding/approval";
import { FundingExecutor } from "../src/funding/executor";
import { PayoutGateway } from "../src/gateway/gateway";
import { Ledger } from "../src/ledger/ledger";
import { fromMinor } from "../src/money";
import { resolveBeneficiary } from "../src/server/runtime";

type KillPoint = "before" | "after";
type Scenario = KillPoint | "convert-before" | "convert-after";

const secret = process.env.TESSERA_APPROVAL_SECRET;
if (!secret) throw new Error("TESSERA_APPROVAL_SECRET is not set");
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

/** The real FX API, except that the conversion create takes the whole process down at the chosen moment. */
function selfDestructingFx(when: KillPoint): AirwallexClient {
  return new Proxy(client, {
    get(target, key, receiver) {
      if (key !== "createConversion") return Reflect.get(target, key, receiver);
      return async (request: CreateConversionRequest): Promise<Conversion> => {
        if (when === "before") process.kill(process.pid, "SIGKILL");
        await target.createConversion(request);
        process.kill(process.pid, "SIGKILL");
        await Bun.sleep(60_000);
        throw new Error("unreachable: process should be dead");
      };
    },
  });
}

/** The policy both processes of a conversion scenario use: the EUR floor is set to the wallet as it stands, so it is short. */
const policyWithEurFloor = (floorMinor: number): CommanderPolicy => ({ ...DEFAULT_POLICY, reserveFloorMinor: { ...DEFAULT_POLICY.reserveFloorMinor, EUR: floorMinor } });

const [, , first, second, third] = process.argv;

if (first === "--child") {
  const when = second as KillPoint;
  const ledger = new Ledger(third!);
  const gateway = new PayoutGateway({ ledger, api: new SelfDestructingApi(when), approvalSecret: secret });
  await gateway.submit(JSON.parse(process.argv[5]!) as Approval);
  console.log("child survived (unexpected)");
  process.exit(2);
}

if (first === "--child-convert") {
  const when = second as KillPoint;
  const ledger = new Ledger(third!);
  const executor = new FundingExecutor({ ledger, api: selfDestructingFx(when), approvalSecret: secret, policy: policyWithEurFloor(Number(process.argv[5])) });
  await executor.book(JSON.parse(process.argv[6]!) as FundingApproval);
  console.log("child survived (unexpected)");
  process.exit(2);
}

async function scenario(when: KillPoint): Promise<boolean> {
  const db = `.data/chaos-${when}.db`;
  mkdirSync(".data", { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(db + suffix, { force: true });

  const beneficiaryId = await resolveBeneficiary(client);

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
  const found = await client.findTransferByRequestId(stuck.requestId);
  console.log(`   ledger after crash:   attempt ${stuck.state}, transferId=${stuck.transferId ?? "none"}`);
  console.log(`   airwallex has it?     ${found ? `yes (${found.id})` : "no"}`);

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

/**
 * A EUR SWIFT payment fails transiently and is cancelled; the EUR floor is set to the wallet's balance, so its replacement
 * must be funded from USD. A child books that conversion and is killed mid-create; the parent recovers it.
 */
async function convertScenario(when: KillPoint): Promise<boolean> {
  const db = `.data/chaos-convert-${when}.db`;
  mkdirSync(".data", { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(db + suffix, { force: true });

  const ledger = new Ledger(db);
  const gateway = new PayoutGateway({ ledger, api: client, approvalSecret: secret! });
  const commander = new Commander({ ledger, gateway, balances: client, secret: secret! });
  const simulator = { advance: (id: string, status: string, failureType?: string) => client.simulateTransition(id, status, failureType) };
  const reference = `CHAOS-FX-${when.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  const label: Record<KillPoint, string> = {
    after: "SIGKILL after Airwallex booked the conversion, before the ledger recorded it",
    before: "SIGKILL after the conversion intent was committed, before the request leaves the process",
  };
  console.log(`\n== ${label[when]} (${reference})`);
  const { id } = await seedIncident({ ledger, gateway, commander, simulator, approver: "policy:chaos" }, "transient", {
    reference, beneficiaryId: await resolveBeneficiary(client, process.env, "EUR"), amountMinor: 1_000, currency: "EUR", method: "SWIFT",
  });
  const dead = ledger.latestAttempt(id)!;
  const wallets = (await commander.readWallets())!;
  const policy = policyWithEurFloor(wallets.EUR ?? 0);
  const need = fundingNeed(dead, wallets, policy);
  const approveQuote = async (): Promise<FundingApproval> => {
    const quote = quoteTerms(await client.createQuote({ buy_currency: "EUR", sell_currency: "USD", buy_amount: fromMinor(need.buyMinor, "EUR"), validity: "MIN_1" }));
    return issueFundingApproval(
      {
        kind: "FUNDING", obligationId: id, forAttemptId: dead.id, quoteId: quote.quoteId, currencyPair: quote.currencyPair, buyCurrency: "EUR",
        buyMinor: quote.buyMinor, sellCurrency: "USD", sellMinor: quote.sellMinor, rate: quote.rate, quoteValidTo: quote.validTo,
        evidenceHash: "0".repeat(64), mode: "POLICY", approver: "policy:chaos", expiresAt: new Date(Date.now() + 120_000).toISOString(), nonce: newNonce(),
      },
      secret!,
    );
  };
  const approval = await approveQuote();
  console.log(`   ${dead.state} attempt, EUR wallet ${fromMinor(need.availableMinor, "EUR")} (floor set to it): buy ${fromMinor(need.buyMinor, "EUR")} EUR for ~${fromMinor(approval.payload.sellMinor, "USD")} USD`);
  ledger.close();

  const child = Bun.spawn([process.execPath, import.meta.path, "--child-convert", when, db, String(policy.reserveFloorMinor.EUR), JSON.stringify(approval)], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await child.exited;
  console.log(`   child died: signal=${child.signalCode} exit=${child.exitCode}`);

  const reopened = new Ledger(db);
  const executor = new FundingExecutor({ ledger: reopened, api: client, approvalSecret: secret!, policy });
  const [stuck] = reopened.conversionsFor(id);
  const found = stuck ? await client.findConversionByRequestId(stuck.requestId) : null;
  console.log(`   ledger after crash:   conversion ${stuck?.state ?? "none"}, conversionId=${stuck?.conversionId ?? "none"}`);
  console.log(`   airwallex has it?     ${found ? `yes (${found.conversion_id}, ${found.status})` : "no"}`);

  let refused = false;
  try {
    await executor.book(await approveQuote());
  } catch (error) {
    refused = error instanceof DuplicateConversionError;
  }
  console.log(`   second conversion:    ${refused ? "refused by the funding lock" : "NOT REFUSED"}`);

  const [recovered] = await executor.recover();
  console.log(`   recover():            ${recovered?.outcome}, conversion ${recovered?.conversion.state} ${recovered?.conversion.conversionId ?? ""}`);
  const rerun = await executor.recover();
  console.log(`   recover() again:      ${rerun.length} conversions to resolve`);

  const rows = reopened.conversionsFor(id);
  const atAirwallex = stuck ? await client.findConversionByRequestId(stuck.requestId) : null;
  const final = rows[0];
  const ok =
    child.signalCode === "SIGKILL" &&
    refused &&
    rows.length === 1 &&
    final !== undefined &&
    final.state === "SETTLED" &&
    final.requestId === stuck?.requestId &&
    final.conversionId === atAirwallex?.conversion_id &&
    rerun.length === 0 &&
    reopened.verifyChain().ok;
  console.log(`   RESULT: ${ok ? "PASS exactly one conversion, same request_id, chain intact" : "FAIL"}`);
  reopened.close();
  return ok;
}

const requested = first as Scenario | "convert" | undefined;
const scenarios: Scenario[] =
  requested === undefined ? ["after", "before", "convert-after", "convert-before"] : requested === "convert" ? ["convert-after", "convert-before"] : [requested];
let allPassed = true;
for (const s of scenarios) {
  const passed = s === "convert-after" || s === "convert-before" ? await convertScenario(s === "convert-after" ? "after" : "before") : await scenario(s);
  allPassed = passed && allPassed;
}
process.exit(allPassed ? 0 : 1);
