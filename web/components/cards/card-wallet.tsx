"use client";

import type { CardView, Cards } from "../../../src/server/wire";
import { compactMoney, money } from "@/lib/format";
import { VisaCard, VisaMark } from "./visa-card";

/** Which cards ride in the wallet: live ones first, then those waiting on a person, then the rest, newest first. */
const RANK: Record<CardView["state"], number> = { ACTIVE: 0, PENDING: 1, ISSUING: 1, FROZEN: 2, FAILED: 3, SPENT: 4, CLOSED: 5, REFUSED: 6, DECLINED: 6 };
const SHOWN = 3;
/** How far each card behind the front one peeks above it. */
const STEP = 30;
/** How much of the front card shows above the pocket. */
const FRONT_SHOW = 62;

export interface WalletBalance {
  currency: string;
  availableMinor: number;
  floorMinor: number;
  onBoardMinor: number;
}

/**
 * The cards Tessera has issued, in a wallet: up to three ride in the pocket, the most useful in front, and each rises
 * out of it under the pointer (or the keyboard) to show its face. The pocket carries the working balance the cards
 * spend from. Click a card for its whole story and what can be done with it; an empty wallet offers to issue one.
 */
export function CardWallet({
  cards,
  balance,
  onOpen,
  onIssue,
}: {
  cards: Cards | null;
  balance: WalletBalance | null;
  onOpen: (card: CardView) => void;
  onIssue: () => void;
}) {
  const ranked = [...(cards?.items ?? [])].sort((a, b) => RANK[a.state] - RANK[b.state] || b.createdAt.localeCompare(a.createdAt));
  // The most useful card goes in front, so it is drawn last.
  const shown = ranked.slice(0, SHOWN).reverse();
  const count = Math.max(shown.length, 1);
  const frontTop = 4 + (count - 1) * STEP;
  const live = (cards?.items ?? []).filter((c) => c.state === "ACTIVE").length;
  const toSign = (cards?.items ?? []).filter((c) => c.state === "PENDING").length;

  return (
    // The wrapper is the size container; the wallet inside sizes itself from it (cqw resolves against an ancestor).
    <div className="@container w-full shrink-0">
    <div className="relative w-full" style={{ height: `calc((100cqw - 28px) / 1.586 + ${frontTop + 14}px)` }}>
      {shown.length === 0 ? (
        <button
          type="button"
          onClick={onIssue}
          className="group absolute inset-x-[14px] top-1 aspect-[1.586] cursor-pointer rounded-[16px] border-[1.5px] border-dashed border-fg/25 bg-fg/[0.03] p-4 text-left transition-transform duration-300 hover:-translate-y-2"
          style={{ zIndex: 1 }}
        >
          <span className="flex items-start justify-between text-fg/45">
            <span className="text-[12.5px] font-medium">Issue a Visa card</span>
            <VisaMark className="text-[20px] text-fg/30" />
          </span>
        </button>
      ) : (
        shown.map((card, i) => (
          <button
            key={card.id}
            type="button"
            onClick={() => onOpen(card)}
            aria-label={`${card.merchant} card, ${card.state.toLowerCase()}, ending ${card.last4 ?? "not issued yet"}`}
            className="absolute inset-x-[14px] cursor-pointer rounded-[16px] text-left outline-none transition-transform duration-300 ease-out hover:z-10 hover:-translate-y-[54px] focus-visible:z-10 focus-visible:-translate-y-[54px] focus-visible:ring-2 focus-visible:ring-accent/60"
            style={{ top: 4 + i * STEP, zIndex: i + 1 }}
          >
            <VisaCard card={card} compact />
          </button>
        ))
      )}

      {/* The pocket: stitched, riveted, with a dip in its lip so the front card shows. */}
      <div className="absolute inset-x-0 bottom-0 z-20" style={{ top: frontTop + FRONT_SHOW }}>
        <svg aria-hidden viewBox="0 0 300 120" preserveAspectRatio="none" className="absolute inset-0 size-full drop-shadow-[0_14px_22px_rgb(15_40_110/0.35)]">
          <defs>
            <linearGradient id="pocket-blue" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#5b9bff" />
              <stop offset="1" stopColor="#1d62ec" />
            </linearGradient>
          </defs>
          <path d="M0 18 Q0 4 14 4 H92 C112 4 116 18 150 18 C184 18 188 4 208 4 H286 Q300 4 300 18 V96 Q300 120 276 120 H24 Q0 120 0 96 Z" fill="url(#pocket-blue)" />
          <path
            d="M9 24 Q9 13 20 13 H92 C112 13 116 27 150 27 C184 27 188 13 208 13 H280 Q291 13 291 24 V93 Q291 111 273 111 H27 Q9 111 9 93 Z"
            fill="none"
            stroke="rgb(255 255 255 / 0.42)"
            strokeWidth="1.2"
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <span aria-hidden className="absolute left-[16px] top-[26px] size-2.5 rounded-full bg-[#1a56d6] shadow-[inset_0_1px_1px_rgb(0_0_0/0.35),0_1px_0_rgb(255_255_255/0.35)]" />
        <span aria-hidden className="absolute right-[16px] top-[26px] size-2.5 rounded-full bg-[#1a56d6] shadow-[inset_0_1px_1px_rgb(0_0_0/0.35),0_1px_0_rgb(255_255_255/0.35)]" />
        <div className="relative flex h-full flex-col items-center justify-center px-6 pt-4 text-center text-white">
          <span className="readout truncate text-[clamp(20px,9cqw,30px)] font-medium leading-none tracking-[-0.03em]" title={balance ? money(balance.availableMinor, balance.currency) : undefined}>
            {balance ? compactMoney(balance.availableMinor, balance.currency) : "—"}
          </span>
          <span className="mt-1.5 text-[11.5px] text-white/80">{balance ? `${balance.currency} available to spend` : "Reading Airwallex…"}</span>
          <span className="mt-1 text-[10.5px] text-white/65">
            {live} Visa {live === 1 ? "card" : "cards"} live{toSign > 0 ? ` · ${toSign} to sign` : ""}
          </span>
        </div>
      </div>
    </div>
    </div>
  );
}
