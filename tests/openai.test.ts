import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { runAgent } from "../src/agent/loop";
import { createToolbox } from "../src/agent/toolbox";
import { Closer } from "../src/closer/closer";
import { Commander } from "../src/commander/commander";
import { ModelError } from "../src/commander/model";
import { OpenAICompatibleModel, type ToolFormat } from "../src/commander/openai";
import { killedAttempt, SECRET, world } from "./helpers/world";

const API_KEY = "sk-or-test-0123456789-secret";

interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>;
  tools?: Array<{ type: string; function: { name: string } }>;
}

/** An OpenAI-compatible endpoint answering from a script, one assistant message per call, recording what it was sent. */
function endpoint(...answers: Array<{ content?: string | null; tool_calls?: unknown[]; status?: number; error?: string }>) {
  const requests: ChatRequest[] = [];
  const headers: Headers[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as ChatRequest);
    headers.push(new Headers(init.headers));
    const next = answers[Math.min(requests.length - 1, answers.length - 1)]!;
    if (next.status) return new Response(JSON.stringify({ error: { message: next.error ?? "nope" } }), { status: next.status });
    const message = { role: "assistant", content: next.content ?? null, ...(next.tool_calls ? { tool_calls: next.tool_calls } : {}) };
    return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: next.tool_calls ? "tool_calls" : "stop", message }] }));
  }) as unknown as typeof fetch;
  return { fetchFn, requests, headers };
}

const modelOn = (fetchFn: typeof fetch, toolFormat: ToolFormat = "native") =>
  new OpenAICompatibleModel({ baseUrl: "https://llm.test/v1/", model: "some/model", apiKey: API_KEY, toolFormat, fetch: fetchFn, retryBaseMs: 1 });

async function incidentWorld() {
  const w = world();
  await killedAttempt(w, "91301");
  const commander = new Commander({ ledger: w.ledger, gateway: w.gateway, balances: w.api, secret: SECRET });
  const closer = new Closer({ ledger: w.ledger, api: w.api, gateway: w.gateway, secret: SECRET, paidHoldMs: 0 });
  const toolbox = createToolbox({ ledger: w.ledger, gateway: w.gateway, commander, closer, model: null, actor: "agent:test", acceptClientText: false });
  return { w, toolbox };
}

const Answer = z.object({ ok: z.boolean() });
const ask = (model: OpenAICompatibleModel) => model.extract({ system: "s", user: "u", schema: Answer, toolName: "record", toolDescription: "d" });

describe("an OpenAI-compatible model drives the same toolbox", () => {
  it("native function calling: the tools go out as functions, the call runs through the toolbox, its result comes back as a tool message", async () => {
    const { w, toolbox } = await incidentWorld();
    const { fetchFn, requests, headers } = endpoint(
      { tool_calls: [{ id: "call_1", type: "function", function: { name: "assess_incident", arguments: JSON.stringify({ incidentId: w.obligation.id }) } }] },
      { content: "INV-1001: escalated, because the bank flagged a possible duplicate" },
    );

    const run = await runAgent({ model: modelOn(fetchFn), toolbox, system: "commander", task: "work it" });

    expect(run.calls).toEqual([expect.objectContaining({ tool: "assess_incident", outcome: expect.objectContaining({ ok: true }) })]);
    expect(run.finalText).toContain("INV-1001");
    expect(requests[0]!.tools!.map((t) => t.function.name)).toEqual(toolbox.specs.map((s) => s.name));
    expect(requests[0]!.messages[0]).toEqual({ role: "system", content: "commander" });
    const reply = requests[1]!.messages.at(-1)!;
    expect(reply).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(JSON.parse(reply.content!)).toMatchObject({ ok: true });
    expect(requests[1]!.messages.at(-2)!.tool_calls![0]!.function).toEqual({ name: "assess_incident", arguments: JSON.stringify({ incidentId: w.obligation.id }) });
    expect(headers[0]!.get("authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("Hermes format: no native tools are sent, the signatures are in the system prompt, <tool_call> text runs, and <tool_response> goes back", async () => {
    const { w, toolbox } = await incidentWorld();
    const { fetchFn, requests } = endpoint(
      { content: `Checking it.\n<tool_call>\n{"name": "assess_incident", "arguments": {"incidentId": "${w.obligation.id}"}}\n</tool_call>` },
      { content: "INV-1001: escalated" },
    );

    const run = await runAgent({ model: modelOn(fetchFn, "hermes"), toolbox, system: "commander", task: "work it" });

    expect(run.calls).toEqual([expect.objectContaining({ tool: "assess_incident", outcome: expect.objectContaining({ ok: true }) })]);
    expect(requests[0]!.tools).toBeUndefined();
    const system = requests[0]!.messages[0]!.content!;
    expect(system.startsWith("commander")).toBe(true);
    expect(system).toContain("<tools>");
    for (const spec of toolbox.specs) expect(system).toContain(`"name":"${spec.name}"`);
    const response = requests[1]!.messages.at(-1)!;
    expect(response.role).toBe("user");
    const inner = /<tool_response>\n([\s\S]*)\n<\/tool_response>/.exec(response.content!)![1]!;
    expect(JSON.parse(inner)).toMatchObject({ name: "assess_incident" });
    expect(JSON.parse(JSON.parse(inner).content)).toMatchObject({ ok: true });
    expect(requests[1]!.messages.at(-2)!.content).toContain("<tool_call>");
  });

  it("a malformed call is refused by the toolbox, never guessed into one that runs", async () => {
    const { w, toolbox } = await incidentWorld();
    const { fetchFn } = endpoint(
      { content: "<tool_call>\n{name: replace_payment, incidentId: oops}\n</tool_call>" },
      { tool_calls: [{ id: "call_2", type: "function", function: { name: "replace_payment", arguments: "{incidentId:" } }] },
      { content: "giving up" },
    );
    const hermes = await runAgent({ model: modelOn(fetchFn, "hermes"), toolbox, system: "s", task: "t", maxSteps: 2 });
    expect(hermes.calls.map((c) => c.outcome.ok)).toEqual([false]);

    const { fetchFn: nativeFetch } = endpoint(
      { tool_calls: [{ id: "call_2", type: "function", function: { name: "replace_payment", arguments: "{incidentId:" } }] },
      { content: "giving up" },
    );
    const native = await runAgent({ model: modelOn(nativeFetch), toolbox, system: "s", task: "t" });
    expect(native.calls).toEqual([expect.objectContaining({ tool: "replace_payment", outcome: expect.objectContaining({ ok: false }) })]);
    expect(w.api.all).toHaveLength(1);
  });
});

describe("extraction", () => {
  it("accepts only a call to the offered tool whose arguments pass the schema, in either format", async () => {
    await expect(ask(modelOn(endpoint({ tool_calls: [{ id: "c", type: "function", function: { name: "record", arguments: '{"ok":true}' } }] }).fetchFn))).resolves.toEqual({ ok: true });
    await expect(ask(modelOn(endpoint({ content: '<tool_call>{"name":"record","arguments":{"ok":false}}</tool_call>' }).fetchFn, "hermes"))).resolves.toEqual({ ok: false });

    await expect(ask(modelOn(endpoint({ content: '{"ok": true}' }).fetchFn))).rejects.toBeInstanceOf(ModelError);
    await expect(ask(modelOn(endpoint({ content: '{"ok": true}' }).fetchFn, "hermes"))).rejects.toBeInstanceOf(ModelError);
    await expect(ask(modelOn(endpoint({ tool_calls: [{ id: "c", type: "function", function: { name: "record", arguments: '{"ok":"yes"}' } }] }).fetchFn))).rejects.toBeInstanceOf(ModelError);
    await expect(ask(modelOn(endpoint({ tool_calls: [{ id: "c", type: "function", function: { name: "other", arguments: '{"ok":true}' } }] }).fetchFn))).rejects.toBeInstanceOf(ModelError);
  });

  it("retries a rate limit, gives up on a refusal, and never puts the key in an error", async () => {
    const limited = endpoint({ status: 429 }, { tool_calls: [{ id: "c", type: "function", function: { name: "record", arguments: '{"ok":true}' } }] });
    await expect(ask(modelOn(limited.fetchFn))).resolves.toEqual({ ok: true });
    expect(limited.requests).toHaveLength(2);

    const refused = endpoint({ status: 401, error: "invalid api key" });
    const error = await ask(modelOn(refused.fetchFn)).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ModelError", status: 401 });
    expect(String(error)).not.toContain(API_KEY);
    expect(refused.requests).toHaveLength(1);
  });
});
