"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Acknowledged, api, ApiProblem } from "@/lib/client-api";
import { ago, money } from "@/lib/format";
import { ATTEMPT, SQUARE, STATUS } from "@/lib/status";
import { IncidentListSchema, type Health, type IncidentSummary } from "../../src/server/wire";
import { Button, Frame, Label, Stat, StatStrip, Tag } from "./ui";

const POLL_MS = 4000;

/** Earlier attempts must have ended (they were replaced), so only the latest one can still be moving. */
function AttemptSquares({ item }: { item: IncidentSummary }) {
  const earlier = Math.max(0, item.attemptCount - 1);
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={`${item.attemptCount} attempt${item.attemptCount === 1 ? "" : "s"}`}>
      {Array.from({ length: earlier }, (_, i) => (
        <span key={i} className="size-3 bg-ink" />
      ))}
      {item.latest ? <span className={`size-3 ${SQUARE[item.latest.state]}`} /> : <span className="size-3 border border-rule" />}
    </span>
  );
}

export function Board({ initial, health }: { initial: IncidentSummary[]; health: Health | null }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems((await api("obligations", IncidentListSchema)).items);
    } catch {
      /* the next poll will retry; the page keeps showing the last good list */
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const created = await api("obligations", Acknowledged, { method: "POST", body: { amount: 25 } });
      const id = typeof created.id === "string" ? created.id : null;
      if (id) router.push(`/incidents/${id}`);
      else await refresh();
    } catch (e) {
      setError(e instanceof ApiProblem ? e.problem.message : "Could not create the incident.");
    } finally {
      setCreating(false);
    }
  }

  const inFlight = items.filter((i) => i.status === "PAYING").length;
  const certified = items.filter((i) => i.status === "CLOSED").length;
  const human = items.filter((i) => i.status === "ESCALATED" || i.status === "NEEDS_ACTION").length;

  return (
    <>
      <StatStrip>
        <Stat value={items.length} label="Obligations tracked" />
        <Stat value={inFlight} label="Payments in flight" />
        <Stat value={human} label="Waiting on a person" />
        <Stat value={certified} label="Certified and closed" />
      </StatStrip>

      <section aria-labelledby="incidents" className="mx-auto max-w-[1440px] px-6 pt-14 sm:px-10">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <Label>Live ledger</Label>
            <h2 id="incidents" className="mt-4 font-display text-3xl tracking-wide sm:text-4xl">
              Incidents
            </h2>
          </div>
          <div className="flex items-center gap-4">
            {health ? (
              <span className="hidden items-center gap-3 sm:flex">
                <Tag tone={health.model ? "blue-outline" : "muted"}>{health.model ? "Claude on" : "Claude off"}</Tag>
                <Tag tone={health.sandbox ? "blue-outline" : "muted"}>{health.sandbox ? "Sandbox controls" : "Controls off"}</Tag>
              </span>
            ) : null}
            <Button onClick={create} busy={creating}>
              Pay a sandbox invoice
            </Button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-6 border border-ink px-5 py-4 text-sm">
            {error}
          </p>
        ) : null}

        {items.length === 0 ? (
          <div className="mt-10">
            <Frame>
              <div className="hatch grid place-items-center gap-6 px-6 py-20 text-center">
                <p className="font-display text-2xl tracking-wide">Nothing in flight</p>
                <p className="max-w-md text-sm text-muted">
                  Pay a sandbox invoice to open an incident. The ledger records the intent before any money moves.
                </p>
                <Button onClick={create} busy={creating}>
                  Pay a sandbox invoice
                </Button>
              </div>
            </Frame>
          </div>
        ) : (
          <div className="mt-10 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="border-b border-ink">
                  {["Reference", "Amount", "Status", "Attempts", "Last failure", "Updated"].map((h) => (
                    <th key={h} className="label h-11 pr-6 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const status = STATUS[item.status];
                  return (
                    <tr key={item.id} className="group relative border-b border-rule transition-colors hover:bg-wash">
                      <td className="relative h-[68px] pr-6">
                        <span aria-hidden className="absolute inset-y-0 -left-px w-1 bg-transparent group-hover:bg-blue" />
                        <Link href={`/incidents/${item.id}`} className="font-mono text-[13px] font-medium after:absolute after:inset-0">
                          {item.reference}
                        </Link>
                      </td>
                      <td className="tnum pr-6 text-[15px] font-semibold">{money(item.amountMinor, item.currency)}</td>
                      <td className="pr-6">
                        <Tag tone={status.tone} pulse={status.pulse}>
                          {status.label}
                        </Tag>
                      </td>
                      <td className="pr-6">
                        <AttemptSquares item={item} />
                      </td>
                      <td className="pr-6 text-sm">
                        {item.latest?.failureCode ? (
                          <span className="font-mono text-[13px]">{item.latest.failureCode}</span>
                        ) : (
                          <span className="text-muted">{item.latest ? ATTEMPT[item.latest.state].label : "None"}</span>
                        )}
                      </td>
                      <td className="text-sm text-muted">{ago(item.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
