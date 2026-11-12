"use client";

import type { Health, IncidentSummary, Wallets } from "../../../src/server/wire";
import { compactMoney, money } from "@/lib/format";
import { Btn } from "../kit/metal";
import { Kicker, SegBar, Tile, Tray, TrayHead } from "../kit/widgets";
import { Logo } from "../logo";

function Contactless() {
  return (
    <svg aria-hidden viewBox="0 0 18 18" className="size-[18px] text-fg/60" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M5.2 5.4a5 5 0 0 1 0 7.2" />
      <path d="M8.4 3.4a8 8 0 0 1 0 11.2" />
      <path d="M11.6 1.6a11 11 0 0 1 0 14.8" />
    </svg>
  );
}

/** The account's working currency: USD when held, else the largest wallet. */
function headline(wallets: Wallets["wallets"]) {
  return wallets.find((w) => w.currency === "USD") ?? [...wallets].sort((a, b) => b.availableMinor - a.availableMinor)[0] ?? null;
}

/**
 * Step one, as a rail of widgets: the account card, the working balance split into what can be spent, what the floor
 * keeps and what is on the board, and every other wallet as its own small tile. A wallet below its floor turns red,
 * because that is what stops a replacement.
 */
export function WalletPanel({ wallets, health, items, onCompose }: { wallets: Wallets | null; health: Health | null; items: IncidentSummary[]; onCompose: () => void }) {
  const held = wallets?.wallets ?? [];
  const main = headline(held);
  const rest = held.filter((wallet) => wallet !== main);
  const floors = held.filter((wallet) => wallet.floorMinor > 0).length;
  const onBoard = main ? items.filter((i) => i.currency === main.currency && i.status !== "CLOSED").reduce((sum, i) => sum + i.amountMinor, 0) : 0;

  return (
    <Tray label="Your treasury" className="h-full gap-3 p-3">
      <TrayHead n={1} className="px-2 pt-1" title="Treasury" note="Read live from Airwallex" right={<Btn tone="secondary" onClick={onCompose} title="Send a real payout through Airwallex">+ Payout</Btn>} />

      {/* The card: brushed pearl in light mode, obsidian in dark. */}
      <Tile className="relative shrink-0 overflow-hidden rounded-[26px]! p-5 short:p-4">
        <span aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,transparent_30%,color-mix(in_oklab,var(--fg)_6%,transparent)_48%,transparent_62%)]" />
        <div className="relative flex items-start justify-between">
          <span className="flex items-center gap-2">
            <Logo size={22} />
            <span className="text-[14px] font-bold italic tracking-[0.04em]">TESSERA</span>
          </span>
          <Contactless />
        </div>
        <p className="readout relative mt-6 truncate text-[14.5px] tracking-[0.04em] short:mt-4">{health?.operator ?? "operator"}</p>
        <div className="relative mt-4 flex items-end justify-between gap-3 short:mt-3">
          <span className="min-w-0">
            <Kicker>Account</Kicker>
            <span className="mt-0.5 block truncate text-[13px] font-medium">{health?.offline ? "Offline rehearsal" : "Airwallex sandbox"}</span>
          </span>
          <span className="shrink-0 text-right">
            <Kicker>Floors</Kicker>
            <span className="readout mt-0.5 block text-[13px] font-medium">{String(floors).padStart(2, "0")}</span>
          </span>
        </div>
      </Tile>

      {main ? (
        <Tile className="shrink-0 px-5 py-4 short:py-3">
          <Kicker>{main.currency} available</Kicker>
          <p className="readout mt-1.5 truncate text-[24px] font-medium leading-none tracking-[-0.03em] short:text-[20px]" title={money(main.availableMinor, main.currency)}>
            {money(main.availableMinor, main.currency)}
          </p>
          <SegBar
            className="mt-3"
            parts={[
              { label: "Free to spend", value: Math.max(0, main.availableMinor - main.floorMinor - onBoard), tone: "fg" },
              { label: "Kept by the floor", value: main.floorMinor, tone: "mid" },
              { label: "On the board", value: onBoard, tone: "accent" },
            ]}
          />
          <p className="mt-2 flex justify-between text-[11px] text-fg/45">
            <span>floor {compactMoney(main.floorMinor, main.currency)}</span>
            <span className="text-accent">{compactMoney(onBoard, main.currency)} in play</span>
          </p>
        </Tile>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between px-2 pb-2">
          <Kicker>Other wallets</Kicker>
          <span className="readout text-[11px] text-fg/40">{String(rest.length).padStart(2, "0")}</span>
        </div>
        {wallets === null || !wallets.readable ? (
          <p className="well rounded-[18px]! px-4 py-3 text-[12px] leading-relaxed text-fg/55">
            {wallets === null ? "Reading balances from Airwallex…" : "Balances could not be read just now, so any replacement waits for a person."}
          </p>
        ) : (
          <ul className="thin-scroll grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto p-0.5">
            {rest.map((wallet) => {
              const short = wallet.floorMinor > 0 && wallet.availableMinor < wallet.floorMinor;
              return (
                <Tile as="li" key={wallet.currency} className="rounded-[18px]! px-3.5 py-3">
                  <span className="flex items-center justify-between">
                    <span className="readout text-[11px] font-medium text-fg/55">{wallet.currency}</span>
                    <span className={`size-1.5 rounded-full ${short ? "bg-bad" : wallet.fundingSource ? "bg-accent" : "bg-fg/25"}`} title={short ? "Below its floor" : wallet.fundingSource ? "Can fund a replacement" : "Held"} />
                  </span>
                  <span className="readout mt-1.5 block truncate text-[15px] font-medium tracking-[-0.02em]" title={money(wallet.availableMinor, wallet.currency)}>
                    {compactMoney(wallet.availableMinor, wallet.currency)}
                  </span>
                  <span className={`mt-0.5 block truncate text-[10.5px] ${short ? "text-bad" : "text-fg/45"}`}>
                    {short ? "below its floor" : wallet.floorMinor > 0 ? `keeps ${compactMoney(wallet.floorMinor, wallet.currency)}` : "no floor"}
                  </span>
                </Tile>
              );
            })}
          </ul>
        )}
      </div>
    </Tray>
  );
}
