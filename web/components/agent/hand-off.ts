"use client";

import { useCallback } from "react";
import { useShell } from "../shell";
import { useAgentRun } from "./agent-run";

/**
 * The Visa rail's hand-off. The agent asks for an invoice's single-use card, but only a person can authorize it; the
 * moment one has and Airwallex has issued it, the card is the agent's to pay with. This starts the agent on that one
 * invoice, where it assesses again (policy, not this hook, decides that paying by card is still allowed) and pays the
 * supplier's checkout through Visa's Trusted Agent Protocol, signed with its own key.
 *
 * Returns whether the agent was started: not when no agent is connected, the card is not live yet, or a run is already
 * going (the person can then hand it over from the invoice).
 */
export function useCardHandOff(): (obligationId: string, cardState: string) => boolean {
  const { agentConnected } = useShell();
  const agent = useAgentRun();
  const { running, start } = agent;
  return useCallback(
    (obligationId: string, cardState: string) => {
      if (!agentConnected || cardState !== "ACTIVE" || running) return false;
      start(obligationId);
      return true;
    },
    [agentConnected, running, start],
  );
}

/** What a person is told once they have authorized the card, depending on whether the agent took it from there. */
export function handOffLine(started: boolean, amount: string): string {
  return started
    ? `The card is issued to the agent, which now pays exactly ${amount} through Visa TAP. Watch it under Agent.`
    : `The card is issued. Have the agent pay exactly ${amount} through Visa TAP.`;
}
