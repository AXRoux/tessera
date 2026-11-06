import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExtractRequest, StructuredModel } from "./evidence";
import { type Block, type ConverseRequest, type ConverseResult, type Message, ModelError, postJson } from "./model";

/**
 * Any model behind an OpenAI-compatible Chat Completions endpoint (`POST {baseUrl}/chat/completions`): OpenAI, a local
 * model on Ollama / LM Studio / vLLM, Hermes on Nous Portal or OpenRouter. Tool calls travel one of two ways:
 *
 *   native   the endpoint's own function calling: `tools` in the request, `tool_calls` in the answer
 *            (https://platform.openai.com/docs/api-reference/chat/create).
 *   hermes   the Hermes function-calling format, for hosts that serve Hermes without native tools (as of 2026-11-06
 *            neither Nous Portal's nor OpenRouter's Hermes 4 endpoints list `tools`): the tool signatures go into the
 *            system prompt inside <tools></tools>, the model answers with <tool_call>{"name", "arguments"}</tool_call>
 *            in its text, and results go back as <tool_response> turns
 *            (https://github.com/NousResearch/Hermes-Function-Calling).
 *
 * Either way a tool call is only a proposal: the toolbox validates it against a strict schema, and an extraction counts
 * only if it is a call to the one offered tool whose arguments pass the zod schema. Prose is never parsed into facts.
 */
export type ToolFormat = "native" | "hermes";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  /** Sent as a Bearer token. Optional because local servers often take none. */
  apiKey?: string;
  toolFormat?: ToolFormat;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  retryBaseMs?: number;
}

interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
interface ProposedCall {
  id: string;
  name: string;
  input: unknown;
}

const ToolCallSchema = z.looseObject({
  id: z.string(),
  type: z.literal("function").optional(),
  function: z.looseObject({ name: z.string(), arguments: z.string().nullish() }),
});
const ChatResponseSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        finish_reason: z.string().nullish(),
        message: z.looseObject({ content: z.string().nullish(), tool_calls: z.array(ToolCallSchema).nullish() }),
      }),
    )
    .min(1),
});
const HermesCallSchema = z.looseObject({ name: z.string().min(1), arguments: z.unknown().optional() });

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

const TOOL_CALL = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/** The system prompt Hermes models are trained on for function calling, with Tessera's tools inside <tools>. */
export function hermesToolPrompt(tools: ToolSpec[]): string {
  const signatures = tools.map((t) => JSON.stringify({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return [
    "You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags.",
    "You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions.",
    `Here are the available tools: <tools> ${signatures.join(" ")} </tools>`,
    "For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:",
    '<tool_call>\n{"name": <function-name>, "arguments": <args-dict>}\n</tool_call>',
  ].join("\n");
}

/** The model's <tool_call> blocks, each with a fresh id, and the text around them. An unreadable block is handed on as raw text. */
export function parseHermesCalls(text: string): { calls: ProposedCall[]; rest: string } {
  const calls: ProposedCall[] = [];
  for (const match of text.matchAll(TOOL_CALL)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]!);
    } catch {
      parsed = null;
    }
    const call = HermesCallSchema.safeParse(parsed);
    // A malformed call still reaches the toolbox, as the bare text: its strict schema refuses it and the model is told why.
    calls.push(call.success ? { id: `call_${randomUUID()}`, name: call.data.name, input: call.data.arguments ?? {} } : { id: `call_${randomUUID()}`, name: "unreadable_tool_call", input: match[1]! });
  }
  return { calls, rest: text.replace(TOOL_CALL, "").trim() };
}

/** The agent loop's turns as Chat Completions messages, in the chosen tool format. */
export function toChatMessages(system: string, messages: Message[], format: ToolFormat): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  const names = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      const uses = message.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
      for (const use of uses) names.set(use.id, use.name);
      if (format === "hermes") {
        const calls = uses.map((u) => `<tool_call>\n${JSON.stringify({ name: u.name, arguments: u.input ?? {} })}\n</tool_call>`);
        out.push({ role: "assistant", content: [text, ...calls].filter(Boolean).join("\n") || null });
      } else {
        const calls = uses.map((u) => ({ id: u.id, type: "function" as const, function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } }));
        out.push({ role: "assistant", content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      }
      continue;
    }
    const responses: string[] = [];
    for (const block of message.content) {
      if (block.type === "text") out.push({ role: "user", content: block.text });
      else if (block.type === "tool_result") {
        if (format === "native") out.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.content });
        else responses.push(`<tool_response>\n${JSON.stringify({ name: names.get(block.tool_use_id) ?? "unknown", content: block.content })}\n</tool_response>`);
      }
    }
    // Hermes reads results as one turn of <tool_response> blocks; a plain user turn works on every compatible host.
    if (responses.length > 0) out.push({ role: "user", content: responses.join("\n") });
  }
  return out;
}

/**
 * Native arguments arrive as a JSON string the model wrote. Unparseable ones are handed on as they are: the toolbox's
 * strict schemas refuse them and the model is told why, which is what should happen to a malformed call.
 */
function parseArguments(raw: string | null | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class OpenAICompatibleModel implements StructuredModel {
  private readonly format: ToolFormat;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.format = opts.toolFormat ?? "native";
  }

  async extract<T>(request: ExtractRequest<T>, signal?: AbortSignal): Promise<T> {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(request.schema) as Record<string, unknown>;
    const tool: ToolSpec = { name: request.toolName, description: request.toolDescription, parameters };
    const instruction = `Answer only by calling the ${request.toolName} tool exactly once. Write no other text.`;
    const turn = await this.turn(`${request.system}\n${instruction}`, [{ role: "user", content: request.user }], [tool], 1024, signal);
    const call = turn.calls.find((c) => c.name === request.toolName);
    if (!call) throw new ModelError("model returned no tool call", null);
    const result = request.schema.safeParse(call.input);
    if (!result.success) throw new ModelError(`model output failed validation: ${result.error.message}`, null);
    return result.data;
  }

  /** One turn of a tool-use conversation, translated to and from Chat Completions. */
  async converse(request: ConverseRequest): Promise<ConverseResult> {
    const tools = request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema }));
    const turn = await this.turn(request.system, request.messages, tools, 2048, request.signal);
    const content: Block[] = [];
    if (turn.text) content.push({ type: "text", text: turn.text });
    for (const call of turn.calls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    return { content, stopReason: turn.stopReason };
  }

  private async turn(system: string, messages: Message[], tools: ToolSpec[], maxTokens: number, signal?: AbortSignal) {
    const hermes = this.format === "hermes";
    const body = {
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? maxTokens,
      messages: toChatMessages(hermes ? `${system}\n\n${hermesToolPrompt(tools)}` : system, messages, this.format),
      // "auto", not a forced call: several compatible servers reject a forced tool_choice.
      ...(hermes ? {} : { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }),
    };
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {};
    const parsed = ChatResponseSchema.safeParse(await postJson(url, headers, JSON.stringify(body), this.opts, signal));
    if (!parsed.success) throw new ModelError("model returned a response this client cannot read", null);
    const choice = parsed.data.choices[0]!;
    const content = choice.message.content ?? "";
    if (hermes) {
      const { calls, rest } = parseHermesCalls(content);
      return { text: rest, calls, stopReason: choice.finish_reason ?? null };
    }
    const calls = (choice.message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }));
    return { text: content.trim(), calls, stopReason: choice.finish_reason ?? null };
  }
}
