"use client";

import { useEffect, useState } from "react";

/** A clock that re-renders on an interval, so "3s ago" keeps meaning something without a write. */
export function useNow(intervalMs = 4000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
