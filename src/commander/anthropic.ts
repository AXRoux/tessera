import { z } from "zod";
import type { ExtractRequest, StructuredModel } from "./evidence";
import { type Block, type ConverseRequest, type ConverseResult, ModelError, postJson } from "./model";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  /** Base delay for retrying 429/5xx; doubles each attempt. */
  retryBaseMs?: number;
}

const ResponseSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() })),
});

const ConverseResponseSchema = z.looseObject({
  stop_reason: z.string().nullable().optional(),
  content: z.array(
    z.discriminatedUnion("type", [
      z.looseObject({ type: z.literal("text"), text: z.string() }),
      z.looseObject({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
      z.looseObject({ type: z.literal("thinking") }),
      z.looseObject({ type: z.literal("redacted_thinking") }),
    ]),
  ),
});

/**
 * Claude through Anthropic's Messages API. Extraction is schema-constrained through tool use: the answer must be a call
 * to the one offered tool whose input passes our zod schema, so free text can never reach the policy.
 */
export class AnthropicModel implements StructuredModel {
  constructor(private readonly opts: AnthropicOptions) {}

  async extract<T>(request: ExtractRequest<T>, signal?: AbortSignal): Promise<T> {
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(request.schema) as Record<string, unknown>;
    const body = JSON.stringify({
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? 1024,
      system: `${request.system}\nAnswer only by calling the ${request.toolName} tool exactly once. Write no other text.`,
      messages: [{ role: "user", content: request.user }],
      tools: [{ name: request.toolName, description: request.toolDescription, input_schema: inputSchema }],
      // This model family rejects forced tool_choice, so the tool is offered with "auto" and the answer is
      // accepted only if it is a tool call that passes the schema.
      tool_choice: { type: "auto" },
    });

    const json = await this.post(body, signal);
    const parsed = ResponseSchema.safeParse(json);
    const call = parsed.success ? parsed.data.content.find((b) => b.type === "tool_use" && b.name === request.toolName) : undefined;
    if (!call) throw new ModelError("model returned no tool call", null);

    const result = request.schema.safeParse(call.input);
    if (!result.success) throw new ModelError(`model output failed validation: ${result.error.message}`, null);
    return result.data;
  }

  /** One turn of a tool-use conversation. The caller runs the tools and sends the results back. */
  async converse(request: ConverseRequest): Promise<ConverseResult> {
    const json = await this.post(
      JSON.stringify({
        model: this.opts.model,
        max_tokens: this.opts.maxTokens ?? 2048,
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        tool_choice: { type: "auto" },
      }),
      request.signal,
    );
    const parsed = ConverseResponseSchema.safeParse(json);
    if (!parsed.success) throw new ModelError("model returned a response this client cannot read", null);
    const content = parsed.data.content.flatMap((b): Block[] =>
      b.type === "text" ? [{ type: "text", text: b.text }] : b.type === "tool_use" ? [{ type: "tool_use", id: b.id, name: b.name, input: b.input }] : [],
    );
    return { content, stopReason: parsed.data.stop_reason ?? null };
  }

  private post(body: string, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
    return postJson(url, { "x-api-key": this.opts.apiKey, "anthropic-version": "2023-06-01" }, body, this.opts, signal);
  }
}
