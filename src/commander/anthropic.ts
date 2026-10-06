import { z } from "zod";
import type { ExtractRequest, StructuredModel } from "./evidence";

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

/** A failed model call. Never carries the API key or request body. */
export class ModelError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "ModelError";
  }
}

const ResponseSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() })),
});
const ErrorSchema = z.looseObject({ error: z.looseObject({ message: z.string().optional() }).optional() });

const RETRYABLE = new Set([408, 429, 500, 502, 503, 529]);

/**
 * Schema-constrained extraction through Claude's tool use. Forcing the tool means the answer is JSON that must
 * pass our zod schema; free text can never reach the policy.
 */
export class AnthropicModel implements StructuredModel {
  constructor(private readonly opts: AnthropicOptions) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): AnthropicModel {
    const apiKey = env.ANTHROPIC_API_KEY;
    const model = env.PAYONCE_MODEL;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    if (!model) throw new Error("PAYONCE_MODEL is not set");
    return new AnthropicModel({ apiKey, model });
  }

  async extract<T>(request: ExtractRequest<T>): Promise<T> {
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

    const json = await this.post(body);
    const parsed = ResponseSchema.safeParse(json);
    const call = parsed.success ? parsed.data.content.find((b) => b.type === "tool_use" && b.name === request.toolName) : undefined;
    if (!call) throw new ModelError("model returned no tool call", null);

    const result = request.schema.safeParse(call.input);
    if (!result.success) throw new ModelError(`model output failed validation: ${result.error.message}`, null);
    return result.data;
  }

  private async post(body: string): Promise<unknown> {
    const url = `${this.opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await (this.opts.fetch ?? fetch)(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.opts.apiKey, "anthropic-version": "2023-06-01" },
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
        });
      } catch (cause) {
        if (attempt < 2) {
          await Bun.sleep((this.opts.retryBaseMs ?? 500) * 2 ** attempt);
          continue;
        }
        throw new ModelError(`model request failed: ${cause instanceof Error ? cause.message : "network error"}`, null);
      }

      if (response.ok) return response.json();
      if (RETRYABLE.has(response.status) && attempt < 2) {
        await Bun.sleep((this.opts.retryBaseMs ?? 500) * 2 ** attempt);
        continue;
      }
      const error = ErrorSchema.safeParse(await response.json().catch(() => ({})));
      throw new ModelError(`model API ${response.status}: ${(error.success && error.data.error?.message) || response.statusText}`, response.status);
    }
  }
}
