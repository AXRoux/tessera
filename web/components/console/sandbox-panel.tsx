"use client";

import { useId, useState } from "react";
import { Acknowledged, api } from "@/lib/client-api";
import { titleCase } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";

import { Select } from "../kit/select";
import { Field } from "./fields";
import type { RunAction } from "./actions-panel";
import { Btn } from "../kit/metal";

/** The failures worth rehearsing: one per branch of the playbook. */
const FAILURES = [
  "CHANNEL_TIMEOUT",
  "BENEFICIARY_BANK_RETURNED",
  "INVALID_ACCOUNT_NAME_OR_NUMBER",
  "DUPLICATION_RETURN",
  "TM_SUSPENDED",
  "RECALL_REQUESTED",
  "INSUFFICIENT_FUNDS",
];

/** Drives Airwallex's simulator so a whole incident can be played out without waiting on a bank. Sandbox only. */
export function SandboxPanel({ view, busy, run, clockMs = null }: { view: IncidentView; busy: string | null; run: RunAction; clockMs?: number | null }) {
  const selectId = useId();
  const [failure, setFailure] = useState(FAILURES[0]!);
  const id = view.obligation.id;
  const latest = view.attempts.at(-1);
  const movable = Boolean(latest?.transferId) && (latest?.state === "LIVE" || latest?.state === "PAID");

  const simulate = (key: string, body: { status: string; failureType?: string }, title: string) =>
    run(key, async () => {
      await api(`obligations/${id}/simulate`, Acknowledged, { method: "POST", body });
      return { tone: "ok", title, lines: [] };
    });

  return (
    <div className="space-y-4">
      <p className="well rounded-[18px]! px-4 py-3 text-[12.5px] leading-relaxed text-fg/65">
        Play the bank&rsquo;s part. These buttons drive Airwallex&rsquo;s own simulator, so you can carry an exception from first failure to certificate without waiting on anyone. Sandbox only;
        no real money.
        {clockMs ? (
          <span className="mt-1.5 block text-fg/55">
            Left alone, a payment is sent and paid once it has waited {Math.max(1, Math.round(clockMs / 1000))} seconds: the sandbox never answers by itself, so Tessera answers for the bank. Press a
            button before then to play it yourself.
          </span>
        ) : null}
      </p>
      {!movable ? (
        <p className="text-[12px] leading-relaxed text-fg/50">There is no live transfer on this incident to move just now.</p>
      ) : null}
      <div>
        <span className="kicker block">A good outcome</span>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Btn tone="secondary" disabled={!movable} busy={busy === "sent"} onClick={() => simulate("sent", { status: "SENT" }, "Marked as sent")}>
            Mark sent
          </Btn>
          <Btn tone="secondary" disabled={!movable} busy={busy === "paid"} onClick={() => simulate("paid", { status: "PAID" }, "Marked as paid")}>
            Mark paid
          </Btn>
        </div>
      </div>
      <div className="space-y-2">
        <span className="kicker block">A bad one</span>
        <Field label="How the bank should fail" htmlFor={selectId}>
          <Select id={selectId} value={failure} onChange={setFailure} options={FAILURES.map((f) => ({ value: f, label: titleCase(f) }))} />
        </Field>
        <Btn
          tone="secondary"
          block
          disabled={!movable}
          busy={busy === "fail"}
          onClick={() => simulate("fail", { status: "FAILED", failureType: failure }, `Failed: ${titleCase(failure)}`)}
        >
          Fail the transfer
        </Btn>
      </div>
    </div>
  );
}
