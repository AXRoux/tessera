import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { AnthropicModel, ModelError } from "../src/commander/anthropic";

const API_KEY = "sk-ant-test-0123456789-secret";
const Answer = z.object({ ok: z.boolean() });
const ask = (model: AnthropicModel) =>
  model.extract({ system: "s", user: "u", schema: Answer, toolName: "record", toolDescription: "d" });

const toolCall = (input: unknown) => ({ content: [{ type: "tool_use", name: "record", input }] });

/** A fetch that answers from a script, one response per call. */
function scripted(...responses: Array<{ status?: number; body: unknown }>) {
  let calls = 0;
  const fetchFn = (async () => {
    const next = responses[Math.min(calls++, responses.length - 1)]!;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => calls };
}

const modelWith = (fetchFn: typeof fetch) => new AnthropicModel({ apiKey: API_KEY, model: "m", fetch: fetchFn, retryBaseMs: 1 });

describe("model transport", () => {
  it("returns the tool call's input once it passes the schema", async () => {
    const { fetchFn } = scripted({ body: toolCall({ ok: true }) });

    await expect(ask(modelWith(fetchFn))).resolves.toEqual({ ok: true });
  });

  it("retries an overloaded response and then succeeds", async () => {
    const { fetchFn, calls } = scripted({ status: 529, body: { error: { message: "Overloaded" } } }, { body: toolCall({ ok: true }) });

    await expect(ask(modelWith(fetchFn))).resolves.toEqual({ ok: true });
    expect(calls()).toBe(2);
  });

  it("does not retry a rejected request", async () => {
    const { fetchFn, calls } = scripted({ status: 400, body: { error: { message: "bad request" } } });

    await expect(ask(modelWith(fetchFn))).rejects.toMatchObject({ name: "ModelError", status: 400 });
    expect(calls()).toBe(1);
  });

  it("rejects an answer that is prose instead of a tool call", async () => {
    const { fetchFn } = scripted({ body: { content: [{ type: "text", text: "Sure! The supplier was paid." }] } });

    await expect(ask(modelWith(fetchFn))).rejects.toBeInstanceOf(ModelError);
  });

  it("rejects a tool call whose input breaks the schema", async () => {
    const { fetchFn } = scripted({ body: toolCall({ ok: "definitely" }) });

    await expect(ask(modelWith(fetchFn))).rejects.toBeInstanceOf(ModelError);
  });

  it("never puts the API key in an error", async () => {
    const { fetchFn } = scripted({ status: 401, body: { error: { message: "invalid x-api-key" } } });

    const error = await ask(modelWith(fetchFn)).catch((e: unknown) => e);

    expect(String(error)).not.toContain(API_KEY);
  });
});
