"use client";

import { useId, useState } from "react";
import { Acknowledged, api } from "@/lib/client-api";
import { titleCase } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";
import { Button, Frame, Label, PanelHeader } from "../ui";
import { Field, Select } from "./fields";
import type { RunAction } from "./actions-panel";

/** The failures worth demonstrating: one per branch of the playbook. */
const FAILURES = [
  "CHANNEL_TIMEOUT",
  "BENEFICIARY_BANK_RETURNED",
  "INVALID_ACCOUNT_NAME_OR_NUMBER",
  "DUPLICATION_RETURN",
  "TM_SUSPENDED",
  "RECALL_REQUESTED",
  "INSUFFICIENT_FUNDS",
];

/** Drives Airwallex's simulator so the whole incident can be played without waiting on a bank. Sandbox only. */
export function SandboxPanel({ view, busy, run }: { view: IncidentView; busy: string | null; run: RunAction }) {
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
    <Frame tone="rule">
      <PanelHeader title="Sandbox controls" right={<Label>Airwallex simulator</Label>} />
      <div className="space-y-5 p-5">
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" disabled={!movable} busy={busy === "sent"} onClick={() => simulate("sent", { status: "SENT" }, "Marked SENT")}>
            Mark sent
          </Button>
          <Button variant="secondary" disabled={!movable} busy={busy === "paid"} onClick={() => simulate("paid", { status: "PAID" }, "Marked PAID")}>
            Mark paid
          </Button>
        </div>
        <Field label="Bank failure" htmlFor={selectId}>
          <Select id={selectId} value={failure} onChange={(e) => setFailure(e.target.value)}>
            {FAILURES.map((f) => (
              <option key={f} value={f}>
                {titleCase(f)}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" className="w-full" disabled={!movable} busy={busy === "fail"} onClick={() => simulate("fail", { status: "FAILED", failureType: failure }, `Failed with ${titleCase(failure)}`)}>
          Fail the transfer
        </Button>
      </div>
    </Frame>
  );
}
