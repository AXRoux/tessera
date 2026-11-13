/**
 * Whether a model key will actually work, checked before it is sealed into a workspace.
 *
 * Anthropic: its model list needs the key, so listing it checks both the key and the model id.
 *
 * OpenAI-compatible: a model list proves little. Some providers serve it to anyone (Nous Research does, so a bad key
 * still gets a 200) and some list models they no longer run (Nous retired Hermes 4 but its id still turns up in old
 * docs). So the check is one tiny chat completion to the named model with one tool attached: it fails exactly when the
 * agent would (a bad key, no credit, a retired model, a model that cannot call tools), and the provider's own words go
 * back to the person. It costs a handful of tokens.
 */

export class ModelKeyRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelKeyRejected";
  }
}

export interface ModelCheckKeys {
  provider: "anthropic" | "openai";
  modelId: string;
  apiKey: string;
  baseUrl: string | null;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The provider's own explanation, from the shapes they use: `{error: {message}}`, `{message}`, or plain text. */
function providerWords(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    const message = typeof json.error === "string" ? json.error : (json.error?.message ?? json.message ?? json.detail);
    if (typeof message === "string" && message.trim()) return message.trim().replace(/\s+/g, " ").slice(0, 220);
  } catch {
    // not JSON: use the text
  }
  return body.trim().replace(/\s+/g, " ").slice(0, 220);
}

/** Ends the provider's words with exactly one stop. */
const sentence = (words: string): string => (/[.!?]$/.test(words) ? words : `${words}.`);

/** Ids from a model list that look like what was typed: they share a word of three letters or more. Batch variants left out. */
function closeMatches(typed: string, listed: string[]): string[] {
  const words = typed.toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length >= 3);
  return listed.filter((id) => !id.includes(":batch") && words.some((w) => id.toLowerCase().includes(w))).slice(0, 4);
}

/** Model ids the endpoint lists, or null when it has no list (or will not show it). */
async function listedModels(base: string, headers: Record<string, string>, fetchImpl: Fetch): Promise<string[] | null> {
  const response = await fetchImpl(`${base}/models`, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!response?.ok) return null;
  const data = ((await response.json().catch(() => null)) as { data?: { id?: unknown }[] } | null)?.data;
  return Array.isArray(data) ? data.map((m) => m.id).filter((id): id is string => typeof id === "string") : null;
}

async function checkAnthropic(keys: ModelCheckKeys, fetchImpl: Fetch): Promise<void> {
  const response = await fetchImpl("https://api.anthropic.com/v1/models?limit=1000", {
    headers: { "x-api-key": keys.apiKey, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response) throw new ModelKeyRejected("Anthropic could not be reached. Try again in a moment.");
  if (response.status === 401 || response.status === 403) throw new ModelKeyRejected("Anthropic did not accept this key.");
  if (!response.ok) throw new ModelKeyRejected(`Anthropic answered ${response.status}. Try again in a moment.`);
  const listed = ((await response.json().catch(() => null)) as { data?: { id?: string }[] } | null)?.data?.map((m) => m.id).filter((id): id is string => typeof id === "string") ?? [];
  if (listed.length > 0 && !listed.includes(keys.modelId)) {
    const near = closeMatches(keys.modelId, listed);
    throw new ModelKeyRejected(`Anthropic has no model named ${keys.modelId} for this key. Try ${(near.length > 0 ? near : listed).slice(0, 4).join(", ")}.`);
  }
}

async function checkOpenAiCompatible(keys: ModelCheckKeys, fetchImpl: Fetch): Promise<void> {
  const base = keys.baseUrl!.replace(/\/+$/, "");
  const host = new URL(base).host;
  const headers = { authorization: `Bearer ${keys.apiKey}`, "content-type": "application/json" };
  const response = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: keys.modelId,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 16,
      // The agent works only through tools, so a model that cannot call them is no use to it.
      tools: [{ type: "function", function: { name: "ping", description: "Connection check.", parameters: { type: "object", properties: {} } } }],
    }),
    signal: AbortSignal.timeout(45_000),
  }).catch(() => null);
  if (!response) throw new ModelKeyRejected(`${host} could not be reached. Check the endpoint (it should end in /v1 for most providers) and try again.`);
  if (response.ok || response.status === 429) return; // 429: the key works, the provider is only busy.
  const words = providerWords(await response.text().catch(() => ""));
  if (response.status === 401 || response.status === 403) throw new ModelKeyRejected(`${host} did not accept this key: ${words}`);
  if (response.status === 402) throw new ModelKeyRejected(`${host} says this key cannot pay for calls: ${words}`);
  if (response.status === 400 || response.status === 404 || response.status === 422) {
    const listed = await listedModels(base, headers, fetchImpl);
    const near = listed ? closeMatches(keys.modelId, listed) : [];
    const known = listed?.includes(keys.modelId);
    const hint = near.length > 0 && !known ? ` Models it serves with a similar name: ${near.join(", ")}.` : "";
    throw new ModelKeyRejected(`${host} cannot run ${keys.modelId} for the agent: ${sentence(words)}${hint}`);
  }
  throw new ModelKeyRejected(`${host} answered ${response.status}: ${sentence(words)} Try again in a moment.`);
}

/** Throws `ModelKeyRejected` with a sentence a person can act on, or returns when the key and model will work. */
export async function checkModelKeys(keys: ModelCheckKeys, fetchImpl: Fetch = fetch): Promise<void> {
  return keys.provider === "anthropic" ? checkAnthropic(keys, fetchImpl) : checkOpenAiCompatible(keys, fetchImpl);
}
