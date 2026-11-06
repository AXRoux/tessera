"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import { money } from "@/lib/format";
import { WalletsSchema, type Wallets } from "../../src/server/wire";
import { Label } from "./ui";

const POLL_MS = 5000;

/**
 * Every wallet next to the reserve floor the policy keeps in it, so a short wallet (and the conversion that fixes it) is
 * visible on the board. Read from Airwallex by the API each time; "unreadable" means every replacement fails closed.
 */
export function WalletStrip() {
  const [wallets, setWallets] = useState<Wallets | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api("wallets", WalletsSchema)
        .then((w) => alive && setWallets(w))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!wallets) return null;
  return (
    <div className="border-b border-rule">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-8 gap-y-2 px-6 py-3 sm:px-10">
        <Label>Wallets</Label>
        {!wallets.readable ? (
          <span className="text-sm text-muted">Airwallex balances could not be read; replacements wait for a person.</span>
        ) : (
          wallets.wallets.map((w) => {
            const below = w.floorMinor > 0 && w.availableMinor < w.floorMinor;
            return (
              <span key={w.currency} className={`tnum text-sm ${below ? "font-semibold" : ""}`} title={w.fundingSource ? "May fund another wallet's replacement" : "Never sold"}>
                {money(w.availableMinor, w.currency)}
                {w.floorMinor > 0 ? <span className="text-muted"> / floor {money(w.floorMinor, w.currency)}</span> : null}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}
