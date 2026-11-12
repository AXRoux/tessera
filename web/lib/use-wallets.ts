"use client";

import { useEffect, useState } from "react";
import type { Wallets } from "../../src/server/wire";
import { WalletsSchema } from "../../src/server/wire";
import { api } from "./client-api";

const POLL_MS = 5000;

/** The Airwallex balances the page was rendered with, kept current. A failed read keeps the last good one. */
export function useWallets(initial: Wallets | null): Wallets | null {
  const [wallets, setWallets] = useState(initial);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api("wallets", WalletsSchema)
        .then((next) => alive && setWallets(next))
        .catch(() => undefined);
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return wallets;
}
