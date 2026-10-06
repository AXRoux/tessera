import { issueApproval, newNonce, type Approval, type ApprovalPayload } from "../../src/approval/approval";
import { PayoutGateway } from "../../src/gateway/gateway";
import { Ledger, type Attempt, type Obligation } from "../../src/ledger/ledger";
import { FakePayoutApi } from "./fake-awx";

export const SECRET = "test-secret-test-secret-test-secret-32";

export interface World {
  ledger: Ledger;
  api: FakePayoutApi;
  gateway: PayoutGateway;
  obligation: Obligation;
}

/** A fresh in-memory ledger, fake Airwallex and gateway, with one 100.00 USD LOCAL obligation. */
export function world(): World {
  const ledger = new Ledger(":memory:");
  const api = new FakePayoutApi();
  const gateway = new PayoutGateway({ ledger, api, approvalSecret: SECRET });
  const obligation = ledger.createObligation({
    reference: "INV-1001",
    beneficiaryId: "ben-A",
    amountMinor: 10_000,
    currency: "USD",
    method: "LOCAL",
    reason: "professional_business_services",
  });
  return { ledger, api, gateway, obligation };
}

export function approve(obligation: Obligation, overrides: Partial<ApprovalPayload> = {}): Approval {
  return issueApproval(
    {
      obligationId: obligation.id,
      amountMinor: obligation.amountMinor,
      currency: obligation.currency,
      beneficiaryId: obligation.beneficiaryId,
      method: obligation.method,
      reason: obligation.reason,
      replacesAttemptId: null,
      evidenceHash: "a".repeat(64),
      mode: "POLICY",
      approver: "policy:auto",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: newNonce(),
      ...overrides,
    },
    SECRET,
  );
}

/** Pays the obligation, then fails and cancels the transfer with `failureCode`, leaving a DEAD attempt. */
export async function killedAttempt(w: World, failureCode: string): Promise<Attempt> {
  const { attempt } = await w.gateway.submit(approve(w.obligation));
  w.api.advance(attempt.transferId!, "SENT");
  w.api.advance(attempt.transferId!, "FAILED", failureCode);
  w.api.advance(attempt.transferId!, "CANCELLED", failureCode);
  const [dead] = await w.gateway.sync(w.obligation.id);
  return dead!;
}
