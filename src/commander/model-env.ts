import type { AgentModel } from "../agent/loop";
import { AnthropicModel } from "./anthropic";
import type { StructuredModel } from "./evidence";
import { OpenAICompatibleModel, type ToolFormat } from "./openai";

type Env = Record<string, string | undefined>;

export type ModelProvider = "anthropic" | "openai";

export interface ConfiguredModel {
  /** Drives the agent loop and reads supplier messages: one model for both. */
  model: StructuredModel & AgentModel;
  provider: ModelProvider;
  /** How the console and the logs name it: "Claude", or the model id's last segment unless TESSERA_MODEL_LABEL says otherwise. */
  label: string;
  /** Written on every audit event the agent causes, e.g. `agent:claude`, `agent:hermes-4-405b`. */
  actor: string;
}

/** True when the env names any model at all, so a public demo can refuse to spend it. */
export function modelConfigured(env: Env): boolean {
  return Boolean(env.TESSERA_MODEL || env.ANTHROPIC_API_KEY || env.TESSERA_MODEL_API_KEY || env.TESSERA_MODEL_BASE_URL);
}

/**
 * The model the env selects, or null when none is configured. `TESSERA_MODEL_PROVIDER` picks the wire protocol:
 * `anthropic` (default; `ANTHROPIC_API_KEY`) or `openai` for any OpenAI-compatible Chat Completions endpoint
 * (`TESSERA_MODEL_BASE_URL`, optional `TESSERA_MODEL_API_KEY`). `TESSERA_MODEL` is the model id for both. For `openai`,
 * `TESSERA_MODEL_TOOL_FORMAT` is `native` or `hermes` (src/commander/openai.ts), defaulting to `hermes` for a model id
 * that names Hermes and `native` otherwise. A half configuration throws with what is missing: a model that silently
 * stays off looks like a working one that refuses.
 */
export function modelFromEnv(env: Env): ConfiguredModel | null {
  const provider = (env.TESSERA_MODEL_PROVIDER || "anthropic").trim().toLowerCase();
  const id = env.TESSERA_MODEL?.trim();

  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY && !id) return null;
    if (!env.ANTHROPIC_API_KEY) throw new Error("TESSERA_MODEL is set but ANTHROPIC_API_KEY is not (or set TESSERA_MODEL_PROVIDER=openai for an OpenAI-compatible endpoint)");
    if (!id) throw new Error("ANTHROPIC_API_KEY is set but TESSERA_MODEL is not (e.g. claude-sonnet-5-5)");
    const label = env.TESSERA_MODEL_LABEL?.trim() || "Claude";
    return { model: new AnthropicModel({ apiKey: env.ANTHROPIC_API_KEY, model: id }), provider, label, actor: actorFor(env, label) };
  }

  if (provider === "openai") {
    const baseUrl = env.TESSERA_MODEL_BASE_URL?.trim();
    if (!baseUrl && !id) return null;
    if (!baseUrl) throw new Error("TESSERA_MODEL_PROVIDER=openai needs TESSERA_MODEL_BASE_URL (e.g. https://openrouter.ai/api/v1 or http://localhost:11434/v1)");
    if (!URL.canParse(baseUrl)) throw new Error(`TESSERA_MODEL_BASE_URL is not a URL (got ${baseUrl})`);
    if (!id) throw new Error("TESSERA_MODEL_PROVIDER=openai needs TESSERA_MODEL, the model id the endpoint serves");
    const label = env.TESSERA_MODEL_LABEL?.trim() || id.split("/").at(-1)!;
    const apiKey = env.TESSERA_MODEL_API_KEY?.trim();
    const toolFormat = toolFormatFor(env.TESSERA_MODEL_TOOL_FORMAT, id);
    return {
      model: new OpenAICompatibleModel({ baseUrl, model: id, toolFormat, ...(apiKey ? { apiKey } : {}) }),
      provider,
      label,
      actor: actorFor(env, label),
    };
  }

  throw new Error(`TESSERA_MODEL_PROVIDER must be anthropic or openai (got ${env.TESSERA_MODEL_PROVIDER})`);
}

function toolFormatFor(setting: string | undefined, id: string): ToolFormat {
  const value = setting?.trim().toLowerCase();
  if (!value) return /hermes/i.test(id) ? "hermes" : "native";
  if (value === "native" || value === "hermes") return value;
  throw new Error(`TESSERA_MODEL_TOOL_FORMAT must be native or hermes (got ${setting})`);
}

function actorFor(env: Env, label: string): string {
  if (env.TESSERA_AGENT_NAME?.trim()) return env.TESSERA_AGENT_NAME.trim();
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `agent:${slug || "model"}`;
}
