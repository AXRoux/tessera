"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Health, IncidentSummary, Metrics } from "../../src/server/wire";
import { IncidentListSchema, MetricsSchema, SeedResultSchema } from "../../src/server/wire";
import { useAgentRun } from "@/components/agent/agent-run";
import { resetTour } from "@/components/tour";
import { Acknowledged, api, ApiProblem } from "./client-api";

const POLL_MS = 4000;

export interface Board {
  items: IncidentSummary[];
  metrics: Metrics | null;
  waiting: number;
  seeding: boolean;
  resetting: boolean;
  creating: boolean;
  confirmingReset: boolean;
  error: string | null;
  seeded: string | null;
  canSeed: boolean;
  /** An agent run is in flight: the run controls wait for it. */
  running: boolean;
  run: (mode: "commander" | "adversary") => void;
  refresh: () => Promise<void>;
  seed: () => Promise<void>;
  reset: () => Promise<void>;
  /** Sends a real payout through Airwallex, signed with the operator's own note. Resolves to an error sentence, or null on success. */
  create: (payout: { amount: number; reference?: string; note: string }) => Promise<string | null>;
  setConfirmingReset: (on: boolean) => void;
}

const message = (error: unknown, fallback: string): string => (error instanceof ApiProblem ? error.problem.message : fallback);

/**
 * The board's data and the four controls that move it, in one place, because the landing page embeds the board and the
 * control room runs the same thing. Polls while the tab is visible; a reload is always right, so nothing is cached.
 */
export function useBoard(initial: { items: IncidentSummary[]; metrics: Metrics | null; health: Health | null }): Board {
  const router = useRouter();
  const agent = useAgentRun();
  const [items, setItems] = useState(initial.items);
  const [metrics, setMetrics] = useState(initial.metrics);
  const [seeding, setSeeding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [list, numbers] = await Promise.allSettled([api("obligations", IncidentListSchema), api("metrics", MetricsSchema)]);
    if (list.status === "fulfilled") setItems(list.value.items);
    if (numbers.status === "fulfilled") setMetrics(numbers.value);
  }, []);

  // The agent run is the app's, so a run started anywhere on the board refreshes every reader of it.
  const refreshOnProgress = useCallback(() => void refresh(), [refresh]);
  useAgentRun(refreshOnProgress);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const create = useCallback(
    async (payout: { amount: number; reference?: string; note: string }): Promise<string | null> => {
      setCreating(true);
      setError(null);
      try {
        const created = await api("obligations", Acknowledged, { method: "POST", body: payout });
        const id = typeof created.id === "string" ? created.id : null;
        if (id) router.push(`/incidents/${id}`);
        else await refresh();
        return null;
      } catch (e) {
        return message(e, "The payout could not be sent.");
      } finally {
        setCreating(false);
      }
    },
    [refresh, router],
  );

  const seed = useCallback(async () => {
    setSeeding(true);
    setError(null);
    setSeeded(null);
    try {
      const result = await api("demo/seed", SeedResultSchema, { method: "POST" });
      setSeeded(`${result.seeded.length} invoices are on the board, each broken in its own way: ${result.seeded.map((s) => s.reference).join(", ")}.`);
      await refresh();
    } catch (e) {
      setError(message(e, "The demo incidents could not be created."));
    } finally {
      setSeeding(false);
    }
  }, [refresh]);

  const reset = useCallback(async () => {
    setResetting(true);
    setError(null);
    try {
      await api("demo/reset", Acknowledged, { method: "POST" });
      agent.clear();
      resetTour();
      setSeeded(null);
      setConfirmingReset(false);
      await refresh();
    } catch (e) {
      setError(message(e, "The demo could not be reset."));
    } finally {
      setResetting(false);
    }
  }, [agent, refresh]);

  return {
    items,
    metrics,
    waiting: items.filter((item) => item.attention !== null).length,
    seeding,
    resetting,
    creating,
    confirmingReset,
    error,
    seeded,
    canSeed: Boolean(initial.health && (initial.health.offline || initial.health.sandbox)),
    running: agent.running,
    run: (mode) => agent.start(null, mode),
    refresh,
    seed,
    reset,
    create,
    setConfirmingReset,
  };
}
