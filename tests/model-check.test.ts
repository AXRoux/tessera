import { describe, expect, it } from "bun:test";
import { checkModelKeys } from "../src/server/model-check";

const BASE = "https://inference.example.com/v1";
const openai = (modelId: string) => ({ provider: "openai" as const, modelId, apiKey: "sk-test-key", baseUrl: BASE });

/** A fake provider: answers the chat completion with `chat`, the model list with `models`, and records what was asked. */
function provider(chat: { status: number; body: unknown }, models: string[] | null = null) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    if (url.endsWith("/models")) return models ? Response.json({ data: models.map((id) => ({ id })) }) : new Response("", { status: 404 });
    return Response.json(chat.body, { status: chat.status });
  };
  return { fetchImpl, calls };
}

describe("checking a model key before it is sealed", () => {
  it("accepts a key whose model answers a tool-carrying call, and treats a busy provider as a working key", async () => {
    const ok = provider({ status: 200, body: { choices: [{ message: { content: "OK" } }] } });
    await checkModelKeys(openai("z-ai/glm-5.2"), ok.fetchImpl);
    expect(ok.calls[0]!.url).toBe(`${BASE}/chat/completions`);
    expect(ok.calls[0]!.body).toMatchObject({ model: "z-ai/glm-5.2", max_tokens: 16, tools: [expect.objectContaining({ type: "function" })] });
    await checkModelKeys(openai("z-ai/glm-5.2"), provider({ status: 429, body: { message: "slow down" } }).fetchImpl);
  });

  it("refuses a bad key in the provider's own words, even when its model list is public", async () => {
    const bad = provider({ status: 401, body: { status: 401, message: "Your API key is invalid, blocked or out of funds." } }, ["z-ai/glm-5.2"]);
    await expect(checkModelKeys(openai("z-ai/glm-5.2"), bad.fetchImpl)).rejects.toThrow("inference.example.com did not accept this key: Your API key is invalid, blocked or out of funds.");
  });

  it("refuses a retired model with the provider's reason and the similar models it does serve", async () => {
    const retired = provider({ status: 404, body: { message: "This model has been retired. Please select a different model to continue!" } }, ["nousresearch/hermes-5-70b", "z-ai/glm-5.2", "nousresearch/hermes-5-70b:batch"]);
    await expect(checkModelKeys(openai("nousresearch/hermes-4-405b"), retired.fetchImpl)).rejects.toThrow(
      "inference.example.com cannot run nousresearch/hermes-4-405b for the agent: This model has been retired. Please select a different model to continue! Models it serves with a similar name: nousresearch/hermes-5-70b.",
    );
  });

  it("refuses a model that cannot call tools, since the agent works only through tools", async () => {
    const noTools = provider({ status: 400, body: { error: { message: "No endpoints found that support tool use" } } });
    await expect(checkModelKeys(openai("some/chat-only-model"), noTools.fetchImpl)).rejects.toThrow("cannot run some/chat-only-model for the agent: No endpoints found that support tool use.");
  });

  it("checks an Anthropic key against its model list, which needs the key", async () => {
    const anthropic = (modelId: string) => ({ provider: "anthropic" as const, modelId, apiKey: "sk-ant-test", baseUrl: null });
    const denied = async () => new Response("", { status: 401 });
    await expect(checkModelKeys(anthropic("claude-sonnet-5-5"), denied)).rejects.toThrow("Anthropic did not accept this key.");
    const listing = async () => Response.json({ data: [{ id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5" }] });
    await checkModelKeys(anthropic("claude-sonnet-5-5"), listing);
    await expect(checkModelKeys(anthropic("claude-sonnet-4-5"), listing)).rejects.toThrow("Anthropic has no model named claude-sonnet-4-5 for this key. Try claude-sonnet-5-5, claude-opus-5-5.");
  });
});
