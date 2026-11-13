"use client";

import type { CardView } from "../../../src/server/wire";

/** The Visa wordmark, drawn: heavy italic capitals, the way it sits on a card. */
export function VisaMark({ className = "" }: { className?: string }) {
  return (
    <span aria-label="Visa" className={`select-none font-black italic tracking-[-0.06em] ${className}`} style={{ fontFamily: "Arial Black, Helvetica Neue, Arial, sans-serif" }}>
      VISA
    </span>
  );
}

/** Each category is its own material, so a stack reads at a glance: black metal for software, blue for cloud, and so on. */
const FINISH: Record<string, { surface: string; ink: string; sub: string }> = {
  software: {
    surface:
      "conic-gradient(from 200deg at 58% 46%, #0a0a0c 0deg, #4b4c52 28deg, #0b0b0d 70deg, #5a5b62 120deg, #0c0c0e 170deg, #3d3e44 215deg, #0a0a0c 262deg, #55565c 312deg, #0a0a0c 360deg)",
    ink: "text-white",
    sub: "text-white/70",
  },
  cloud: {
    surface: "conic-gradient(from 210deg at 60% 45%, #0b2a7a 0deg, #3b82ff 50deg, #0e3a9e 110deg, #6aa5ff 170deg, #0b2f86 230deg, #2f6df0 300deg, #0b2a7a 360deg)",
    ink: "text-white",
    sub: "text-white/75",
  },
  advertising: {
    surface: "linear-gradient(135deg, #d9f99d 0%, #bef264 40%, #a3e635 70%, #d9f99d 100%)",
    ink: "text-[#14290a]",
    sub: "text-[#14290a]/70",
  },
  travel: {
    surface: "linear-gradient(120deg, #6d5ef5 0%, #8b7cff 35%, #6457e8 60%, #a39bff 85%, #6d5ef5 100%)",
    ink: "text-white",
    sub: "text-white/75",
  },
  office: {
    surface: "conic-gradient(from 200deg at 55% 50%, #e6e8ec 0deg, #ffffff 40deg, #c9ccd3 100deg, #f4f5f7 160deg, #c3c7cf 220deg, #fafafa 290deg, #e6e8ec 360deg)",
    ink: "text-[#101216]",
    sub: "text-[#101216]/60",
  },
};

const finishOf = (category: string) => FINISH[category] ?? FINISH.software!;

/** How a card's state shows on its face: nothing for a live card, a word for everything else. */
export function stateWord(state: CardView["state"]): string | null {
  switch (state) {
    case "PENDING":
      return "Awaiting your signature";
    case "ISSUING":
      return "Issuing at Airwallex";
    case "FROZEN":
      return "Frozen";
    case "SPENT":
      return "Spent";
    case "CLOSED":
      return "Closed";
    case "FAILED":
      return "Airwallex refused";
    case "REFUSED":
      return "Refused by policy";
    case "DECLINED":
      return "Declined";
    default:
      return null;
  }
}

const validTo = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCFullYear()).slice(2)}`;
};

/**
 * One Visa virtual card, face up. Live cards are their category's material; a card waiting for a signature is a
 * proof (pale, dashed), a frozen one is iced, a spent or closed one is grey. The number is never more than its last four.
 */
export function VisaCard({ card, className = "", compact = false }: { card: CardView; className?: string; compact?: boolean }) {
  const finish = finishOf(card.category);
  const live = card.state === "ACTIVE";
  const proof = card.state === "PENDING" || card.state === "ISSUING";
  const dead = card.state === "SPENT" || card.state === "CLOSED" || card.state === "REFUSED" || card.state === "DECLINED" || card.state === "FAILED";
  const word = stateWord(card.state);
  return (
    <div
      className={`relative isolate aspect-[1.586] w-full overflow-hidden rounded-[16px] shadow-[0_18px_30px_-16px_rgb(0_0_0/0.55),inset_0_1px_0_rgb(255_255_255/0.18)] ${finish.ink} ${className}`}
      style={{ background: finish.surface }}
    >
      {/* Brushed sheen and grain, so the metal reads as metal. */}
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,transparent_25%,rgb(255_255_255/0.16)_45%,transparent_60%)] mix-blend-overlay" />
      <span aria-hidden className="grain pointer-events-none absolute inset-0 opacity-30 mix-blend-overlay" />
      {proof ? <span aria-hidden className="absolute inset-0 bg-white/45 backdrop-grayscale [[data-theme=dark]_&]:bg-black/35" /> : null}
      {dead ? <span aria-hidden className="absolute inset-0 bg-[#6b6e75]/55 mix-blend-saturation" /> : null}
      {card.state === "FROZEN" ? <span aria-hidden className="absolute inset-0 bg-[linear-gradient(160deg,rgb(186_230_253/0.55),rgb(224_242_254/0.25))] backdrop-blur-[1px]" /> : null}
      {proof ? <span aria-hidden className="absolute inset-[5px] rounded-[12px] border-[1.5px] border-dashed border-current opacity-40" /> : null}

      <div className={`relative flex h-full flex-col justify-between ${compact ? "p-3.5" : "p-5"}`}>
        <div className="flex items-start justify-between gap-2">
          <span aria-hidden className={`flex gap-[3px] pt-1.5 ${finish.sub}`}>
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-[5px] rounded-full bg-current" />
            ))}
          </span>
          <VisaMark className={compact ? "text-[19px]" : "text-[26px]"} />
        </div>
        {word ? (
          <span className={`self-start rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] ${live ? "" : "bg-black/35 text-white"}`}>{word}</span>
        ) : null}
        <div>
          <div className="flex items-end justify-between gap-3">
            <span className={`min-w-0 truncate font-plex ${compact ? "text-[12.5px]" : "text-[15px]"}`}>{card.merchant}</span>
            <span className={`shrink-0 font-plex ${finish.sub} ${compact ? "text-[11px]" : "text-[13px]"}`}>{validTo(card.activeTo)}</span>
          </div>
          <p className={`mt-1 font-plex tracking-[0.14em] ${compact ? "text-[12px]" : "text-[16px]"}`}>
            <span className={finish.sub}>**** **** **** </span>
            {card.last4 ?? "····"}
          </p>
        </div>
      </div>
    </div>
  );
}
