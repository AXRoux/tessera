"use client";

import { useEffect, useState } from "react";
import type { IncidentView } from "../../src/server/wire";
import { IncidentViewSchema } from "../../src/server/wire";
import { api } from "./client-api";

/**
 * Every incident's ledger, for the charts. Read once by the page, then re-read only when an incident actually changed:
 * `revision` is the board's own signature (which incidents exist and when each last moved), so a quiet board does not
 * refetch eight ledgers every four seconds.
 */
export function useViews(initial: IncidentView[], revision: string): IncidentView[] {
  const [views, setViews] = useState(initial);
  useEffect(() => {
    const ids = revision
      .split("|")
      .filter(Boolean)
      .map((entry) => entry.slice(0, entry.lastIndexOf("@")));
    if (ids.length === 0) return;
    let alive = true;
    void (async () => {
      const read = await Promise.all(ids.map((id) => api(`obligations/${id}`, IncidentViewSchema).catch(() => null)));
      if (!alive) return;
      const live = read.filter((view): view is IncidentView => view !== null);
      // A half-read board is worse than a stale one, so only a complete pass replaces what is on screen.
      if (live.length === ids.length) setViews(live);
    })();
    return () => {
      alive = false;
    };
  }, [revision]);
  return views;
}

/** The board's read signature: which incidents exist, and when each of them last moved. */
export function revisionOf(items: { id: string; updatedAt: string }[]): string {
  return items
    .map((item) => `${item.id}@${item.updatedAt}`)
    .sort()
    .join("|");
}
