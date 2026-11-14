"use client";

import { useState } from "react";
import type { CardView, Cards, Health, IncidentSummary, Wallets } from "../../../src/server/wire";
import { Acknowledged, api, ApiProblem } from "@/lib/client-api";
import { compactMoney, money } from "@/lib/format";
import { CardWallet } from "../cards/card-wallet";
import { Btn, MetalCircle } from "../kit/metal";
import { Icon } from "../landing/icons";
import { Kicker, Tile, Tray, TrayHead } from "../kit/widgets";

/** The account's working currency: USD when held, else the largest wallet. */
function headline(wallets: Wallets["wallets"]) {
  return wallets.find((w) => w.currency === "USD") ?? [...wallets].sort((a, b) => b.availableMinor - a.availableMinor)[0] ?? null;
}

/**
 * Step one, the money: the Visa cards Tessera has issued, riding in a wallet whose pocket carries the working balance,
 * and every other Airwallex wallet as its own small tile. A wallet below its floor turns red, because that is what stops
 * a replacement (and a card).
 */
export function WalletPanel({
  wallets,
  health,
  items,
  cards,
  onCompose,
  onIssueCard,
  onOpenCard,
}: {
  wallets: Wallets | null;
  health: Health | null;
  items: IncidentSummary[];
  cards: Cards | null;
  onCompose: () => void;
  onIssueCard: () => void;
  onOpenCard: (card: CardView) => void;
}) {
  const held = wallets?.wallets ?? [];
  const main = headline(held);
  const rest = held.filter((wallet) => wallet !== main);
  // What the cards have taken from the working wallet, cleared or still clearing: too small to see in a compact balance.
  const onCards = main
    ? (cards?.items ?? []).filter((c) => c.currency === main.currency).reduce((sum, c) => sum + c.spentMinor + c.heldMinor, 0)
    : 0;
  const onBoard = main ? items.filter((i) => i.currency === main.currency && i.status !== "CLOSED").reduce((sum, i) => sum + i.amountMinor, 0) : 0;
  const [staging, setStaging] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  async function stage() {
    setStaging(true);
    setStageError(null);
    try {
      await api("wallets/stage", Acknowledged, { method: "POST", body: {} });
    } catch (error) {
      setStageError(error instanceof ApiProblem ? error.message : "Airwallex did not open the wallets just now. Try again in a minute.");
    } finally {
      setStaging(false);
    }
  }

  return (
    <Tray label="Your treasury" className="h-full gap-3 p-3">
      <TrayHead
        n={1}
        className="px-2 pt-1"
        title="Treasury"
        note="Airwallex wallets · Visa cards"
        right={
          <>
            <MetalCircle label="Ask for a Visa card" onClick={onIssueCard} size={36}>
              <Icon name="wallet" className="size-[17px]" />
            </MetalCircle>
            <Btn tone="secondary" onClick={onCompose} title="Send a real payout through Airwallex">
              + Payout
            </Btn>
          </>
        }
      />

      <CardWallet
        cards={cards}
        balance={main ? { currency: main.currency, availableMinor: main.availableMinor, floorMinor: main.floorMinor, onBoardMinor: onBoard } : null}
        onOpen={onOpenCard}
        onIssue={onIssueCard}
      />
      {main ? (
        <p className="-mt-1 flex justify-between px-2 text-[11px] text-fg/45">
          <span title={money(main.floorMinor, main.currency)}>floor {compactMoney(main.floorMinor, main.currency)}</span>
          {onCards > 0 ? <span title={`${money(onCards, main.currency)} spent on Visa cards, cleared or clearing`}>{money(onCards, main.currency)} on cards</span> : null}
          <span className="text-accent">{compactMoney(onBoard, main.currency)} in play</span>
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between px-2 pb-2">
          <Kicker>Other wallets</Kicker>
          <span className="readout text-[11px] text-fg/40">{String(rest.length).padStart(2, "0")}</span>
        </div>
        {wallets?.readable && rest.length === 0 && health?.sandbox ? (
          // A new sandbox business holds one currency: offer the other wallets the treasury story needs.
          <div className="well rounded-[18px]! px-4 py-3">
            <p className="text-[12px] leading-relaxed text-fg/60">
              Only {main?.currency ?? "one currency"} is held. Open EUR and GBP wallets (bought from USD in the sandbox) to see Tessera fund a short wallet from another.
            </p>
            <div className="mt-2.5">
              <Btn tone="secondary" busy={staging} onClick={() => void stage()}>
                Add EUR and GBP
              </Btn>
            </div>
            {stageError ? <p className="mt-2 text-[11.5px] text-bad">{stageError}</p> : null}
          </div>
        ) : wallets === null || !wallets.readable ? (
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
