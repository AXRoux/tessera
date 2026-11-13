"use client";

import { useCallback, useEffect, useState } from "react";
import { CardsSchema, type Cards } from "../../src/server/wire";
import { api } from "./client-api";

const POLL_MS = 4000;
/** Fired after anything changes a card, so every view of the cards refreshes at once instead of on its next poll. */
export const CARDS_CHANGED = "tessera:cards-changed";
/** Ask the control room to open the card composer, or a card's sheet (`detail` is the card id). */
export const OPEN_CARD_COMPOSER = "tessera:open-card-composer";
export const OPEN_CARD = "tessera:open-card";

export const cardsChanged = (): void => void window.dispatchEvent(new Event(CARDS_CHANGED));

/** The Visa cards, kept current: polled, and reloaded the moment any view changes one. A failed read keeps the last good one. */
export function useCards(): { cards: Cards | null; refresh: () => Promise<void> } {
  const [cards, setCards] = useState<Cards | null>(null);
  const refresh = useCallback(async () => {
    try {
      setCards(await api("cards", CardsSchema));
    } catch {
      // Keep the last good read: a blip must not empty the wallet.
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => !document.hidden && void refresh(), POLL_MS);
    window.addEventListener(CARDS_CHANGED, refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener(CARDS_CHANGED, refresh);
    };
  }, [refresh]);
  return { cards, refresh };
}
