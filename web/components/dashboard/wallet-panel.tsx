"use client";

import { useState } from "react";
import type { Health, Wallets } from "../../../src/server/wire";
import { money } from "@/lib/format";
import { Icon } from "../landing/icons";
import { Logo } from "../logo";
import { Label, Tag } from "../ui";

/** The contactless mark: three arcs, drawn rather than set in a font. */
function Contactless() {
  return (
    <svg aria-hidden viewBox="0 0 18 18" className="size-[18px] text-white/70" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M5.2 5.4a5 5 0 0 1 0 7.2" />
      <path d="M8.4 3.4a8 8 0 0 1 0 11.2" />
      <path d="M11.6 1.6a11 11 0 0 1 0 14.8" />
    </svg>
  );
}

function Chip() {
  return (
    <span aria-hidden className="flex h-[22px] w-[30px] items-center justify-center rounded-[5px] border border-white/25 bg-white/10">
      <span className="h-[10px] w-[18px] rounded-[2px] border border-white/30" />
    </span>
  );
}

/**
 * The account, as a card, over the wallets it is holding. Balances and floors are read from Airwallex every poll; a
 * wallet below its floor is the one thing here that turns red, because it is what stops a replacement.
 */
export function WalletPanel({
  wallets,
  health,
  onCreate,
  creating,
}: {
  wallets: Wallets | null;
  health: Health | null;
  onCreate: () => void;
  creating: boolean;
}) {
  const [open, setOpen] = useState(true);
  const held = wallets?.wallets ?? [];
  const floors = held.filter((wallet) => wallet.floorMinor > 0);
  const below = held.filter((wallet) => wallet.floorMinor > 0 && wallet.availableMinor < wallet.floorMinor);

  return (
    <section id="wallets" data-shell-section className="panel flex min-w-0 flex-col p-5">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-medium tracking-[-0.01em]">Your account</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">Operator, wallets and reserve floors</p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          disabled={creating}
          className="hairline inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border bg-white/[0.04] px-3.5 py-2 text-[12.5px] text-soft transition-colors hover:bg-white/[0.08] disabled:opacity-60"
        >
          <span aria-hidden className="text-[14px] leading-none">
            +
          </span>
          {creating ? "Sending…" : "Send a test invoice"}
        </button>
      </header>

      <div className="glow-card mt-4 p-5">
        <div className="relative flex items-start justify-between">
          <span className="flex items-center gap-2.5">
            <Logo size={24} />
            <span className="text-[13px] font-medium uppercase tracking-[0.22em] text-white/90">Tessera</span>
          </span>
          <Contactless />
        </div>

        <p className="tnum relative mt-7 font-mono text-[15px] text-white">{health?.operator ?? "operator"}</p>
        <p className="relative mt-1.5 text-[12px] text-white/70">{health?.offline ? "Simulated Airwallex · no money moves" : "Airwallex sandbox · no real money"}</p>

        <div className="relative mt-7 flex items-end justify-between gap-4">
          <span className="flex items-center gap-3">
            <Chip />
            <span className="min-w-0">
              <Label className="block text-[10px] uppercase tracking-[0.16em] text-white/55">Holding</Label>
              <span className="block text-[12.5px] text-white/90">{held.length === 0 ? "—" : held.map((wallet) => wallet.currency).join(" · ")}</span>
            </span>
          </span>
          <span className="shrink-0 text-right">
            <Label className="block text-[10px] uppercase tracking-[0.16em] text-white/55">Reserve floors</Label>
            <span className="block text-[12.5px] text-white/90">{floors.length === 0 ? "None set" : `${floors.length} wallet${floors.length === 1 ? "" : "s"}`}</span>
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="mt-5 flex cursor-pointer items-center justify-between gap-3 text-left"
      >
        <span>
          <span className="block text-[13.5px] text-soft">{wallets === null ? "Wallets" : `${held.length} wallet${held.length === 1 ? "" : "s"}`}</span>
          <span className="block text-[12px] text-muted">Read live from Airwallex, with the floor the policy keeps in each</span>
        </span>
        <Icon name="chevron" className={`size-4 shrink-0 text-muted transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>

      {open ? (
        <div className="mt-3">
          {wallets === null || !wallets.readable ? (
            <p className="hatch rounded-2xl border border-white/10 px-4 py-3.5 text-[12.5px] text-muted">
              {wallets === null ? "Balances are being read." : "Airwallex balances could not be read; replacements wait for a person."}
            </p>
          ) : (
            <ul className="divide-y divide-white/[0.07]">
              {held.map((wallet) => {
                const short = wallet.floorMinor > 0 && wallet.availableMinor < wallet.floorMinor;
                return (
                  <li key={wallet.currency} className="flex items-center justify-between gap-3 py-3">
                    <span className="min-w-0">
                      <span className="tnum block text-[14.5px] font-medium">{money(wallet.availableMinor, wallet.currency)}</span>
                      <span className="block text-[11.5px] text-muted">
                        {wallet.floorMinor > 0 ? `floor ${money(wallet.floorMinor, wallet.currency)}` : "no floor"}
                        {wallet.fundingSource ? " · may fund a replacement" : ""}
                      </span>
                    </span>
                    {short ? <Tag tone="ink">Below floor</Tag> : <span className="font-mono text-[12px] text-muted">{wallet.currency}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {below.length > 0 ? (
            <p className="mt-3 text-[12px] leading-relaxed text-danger">
              {below.map((wallet) => wallet.currency).join(", ")} below the floor: a replacement there needs a conversion first.
            </p>
          ) : null}
          {wallets?.fundingSources.length ? (
            <p className="mt-3 text-[11.5px] text-muted">Conversions may sell from: {wallets.fundingSources.join(", ")}.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
