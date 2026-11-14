/**
 * The agent's face in the console. Tessera is agent-agnostic, so the face is a choice, not a fact: by default it follows
 * the connected model (a Claude model shows Claude, a GPT model OpenAI, and so on), and a person can pin any face from
 * the workspace page or by picking an agent at sign-up. Hermes stands in when the model does not say who it is.
 */
export const AGENT_FACE_COOKIE = "tessera-agent";

export const AGENT_FACES = [
  { id: "hermes", name: "Hermes", src: "/agents/hermes-agent-on-dark.svg", full: true },
  { id: "claude", name: "Claude", src: "/agents/claude.svg", full: false },
  { id: "openai", name: "OpenAI", src: "/agents/openai-on-dark.svg", full: false },
  { id: "gemini", name: "Gemini", src: "/agents/gemini.svg", full: false },
  { id: "cursor", name: "Cursor", src: "/agents/cursor-on-dark.svg", full: false },
  { id: "copilot", name: "Copilot", src: "/agents/githubcopilot-on-dark.svg", full: false },
] as const;

export type AgentFace = (typeof AGENT_FACES)[number];
export type AgentFaceId = AgentFace["id"];
/** What a person chose: a face, or "auto" to follow the model. */
export type AgentFaceChoice = AgentFaceId | "auto";

const FALLBACK: AgentFace = AGENT_FACES[0];
const byId = (id: string): AgentFace | undefined => AGENT_FACES.find((f) => f.id === id);

/** Read a stored choice; anything unknown is "auto". */
export const parseFaceChoice = (value: string | undefined | null): AgentFaceChoice => (value && (value === "auto" || byId(value)) ? (value as AgentFaceChoice) : "auto");

/** Who a model says it is, from its name or id: "claude-sonnet-4-5", "openai/gpt-5", "gemini-2.5-pro". Null when it does not say. */
export function faceForModel(name: string | null | undefined): AgentFaceId | null {
  const n = (name ?? "").toLowerCase();
  if (!n) return null;
  if (/claude|anthropic|sonnet|opus|haiku/.test(n)) return "claude";
  if (/gemini|gemma|google\//.test(n)) return "gemini";
  if (/hermes|nous/.test(n)) return "hermes";
  if (/copilot/.test(n)) return "copilot";
  if (/cursor/.test(n)) return "cursor";
  if (/(^|[^a-z])(gpt|o[134](-|$)|chatgpt|codex|openai)/.test(n)) return "openai";
  return null;
}

/** The face to show: a pinned choice wins; "auto" follows the model, and falls back to Hermes. */
export function resolveFace(choice: AgentFaceChoice, modelName: string | null | undefined): AgentFace {
  if (choice !== "auto") return byId(choice) ?? FALLBACK;
  return byId(faceForModel(modelName) ?? "") ?? FALLBACK;
}
