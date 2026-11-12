"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IncidentViewSchema, type IncidentView } from "../../src/server/wire";
import type { Notice } from "@/components/console/fields";
import { api, ApiProblem } from "./client-api";

const POLL_MS = 3000;

export interface RunAction {
  (key: string, work: () => Promise<Notice | void>): Promise<void>;
}

function toNotice(error: unknown): Notice {
  if (error instanceof ApiProblem) {
    const lines = error.problem.reasons ?? error.problem.blockers ?? [error.problem.message];
    return { tone: "refused", title: error.status === 409 ? "The code said no" : "That did not go through", lines };
  }
  return { tone: "refused", title: "That did not go through", lines: [error instanceof Error ? error.message : "Something unexpected happened."] };
}

/**
 * One incident, live: its view, polled while nothing is in flight, and the one way to act on it (`run`), which records
 * what happened as a notice and re-reads the incident afterwards. Shared by the incident page and the queue's workbench.
 */
export function useIncident(id: string | null, initial: IncidentView | null = null) {
  const [view, setView] = useState<IncidentView | null>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const busyRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    const next = await api(`obligations/${id}`, IncidentViewSchema);
    setView((current) => (current === null || current.obligation.id === id ? next : current));
  }, [id]);

  // A different incident: forget the last one's notice, and read the new one at once.
  useEffect(() => {
    setNotice(null);
    if (!id) {
      setView(null);
      return;
    }
    if (initial?.obligation.id !== id) {
      setView(null);
      void refresh().catch(() => undefined);
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll only while idle: a refresh landing mid-action would repaint a half-finished state.
  useEffect(() => {
    if (!id) return;
    const timer = setInterval(() => {
      if (!document.hidden && busyRef.current === null) void refresh().catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [id, refresh]);

  const run: RunAction = useCallback(
    async (key, work) => {
      busyRef.current = key;
      setBusy(key);
      setNotice(null);
      try {
        const result = await work();
        if (result) setNotice(result);
      } catch (error) {
        setNotice(toNotice(error));
      } finally {
        await refresh().catch(() => undefined);
        busyRef.current = null;
        setBusy(null);
      }
    },
    [refresh],
  );

  return { view, busy, notice, setNotice, run, refresh };
}
