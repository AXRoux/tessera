"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { AGENT_FACE_COOKIE, resolveFace, type AgentFace, type AgentFaceChoice } from "@/lib/agent-face";

/** Remember a face on this browser for a year; the layout reads it so the first paint already shows it. */
export function storeFaceChoice(choice: AgentFaceChoice): void {
  document.cookie = `${AGENT_FACE_COOKIE}=${choice}; path=/; max-age=31536000; samesite=lax`;
}

interface AgentFaceState {
  /** The face every agent mark shows. */
  face: AgentFace;
  /** What the person chose: a pinned face, or "auto" to follow the model. */
  choice: AgentFaceChoice;
  /** The face "auto" would show for the connected model right now. */
  auto: AgentFace;
  setChoice: (choice: AgentFaceChoice) => void;
}

const AgentFaceContext = createContext<AgentFaceState | null>(null);

/**
 * Holds the agent's face for the whole console. The model comes from the server on every render (so connecting another
 * model updates it on the next refresh); the choice lives in a cookie the layout read for the first paint.
 */
export function AgentFaceProvider({ initialChoice, modelName, children }: { initialChoice: AgentFaceChoice; modelName: string | null; children: ReactNode }) {
  const [choice, setChoiceState] = useState<AgentFaceChoice>(initialChoice);
  const setChoice = useCallback((next: AgentFaceChoice) => {
    storeFaceChoice(next);
    setChoiceState(next);
  }, []);
  const value = useMemo<AgentFaceState>(
    () => ({ face: resolveFace(choice, modelName), choice, auto: resolveFace("auto", modelName), setChoice }),
    [choice, modelName, setChoice],
  );
  return <AgentFaceContext.Provider value={value}>{children}</AgentFaceContext.Provider>;
}

/** The agent's face and the way to change it. Outside a provider (the sign-up screen), Hermes on "auto". */
export function useAgentFace(): AgentFaceState {
  return useContext(AgentFaceContext) ?? { face: resolveFace("auto", null), choice: "auto", auto: resolveFace("auto", null), setChoice: storeFaceChoice };
}

/** One face, drawn: Hermes is a portrait that fills its square; the logos sit on a dark tile, like the sign-up picker. */
export function FaceGlyph({ face, size, className = "" }: { face: AgentFace; size: number; className?: string }) {
  if (face.full) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- fixed local SVGs; the optimizer adds nothing here.
      <img src={face.src} alt="" aria-hidden width={size} height={size} className={`shrink-0 rounded-[28%] ring-1 ring-black/10 ${className}`} style={{ width: size, height: size }} />
    );
  }
  return (
    <span aria-hidden className={`inline-flex shrink-0 items-center justify-center rounded-[28%] bg-[#0c0d10] ring-1 ring-black/10 ${className}`} style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- fixed local SVGs */}
      <img src={face.src} alt="" width={Math.round(size * 0.58)} height={Math.round(size * 0.58)} className="object-contain" style={{ width: Math.round(size * 0.58), height: Math.round(size * 0.58) }} />
    </span>
  );
}

/**
 * The agent's mark: the face of whichever agent is connected (or the one a person pinned). Tessera is agent-agnostic,
 * so the mark stands for "the agent"; the model's own name is shown beside it as metadata.
 */
export function AgentMark({ size = 18, className = "" }: { size?: number; className?: string }) {
  const { face } = useAgentFace();
  return <FaceGlyph face={face} size={size} className={className} />;
}
