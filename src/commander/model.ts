/**
 * What every model provider shares: the conversation shape the agent loop speaks, the error a failed call becomes, and
 * one JSON POST with bounded retries. Providers (anthropic.ts, openai.ts) translate to and from their own wire format;
 * nothing above them knows which one is running.
 */

/** A failed model call. Never carries the API key or request body. */
export class ModelError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "ModelError";
  }
}

/** One block of a conversation turn, in the agent loop's own terms (they happen to match Anthropic's Messages API). */
export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export interface Message {
  role: "user" | "assistant";
  content: string | Block[];
}
export interface ConverseRequest {
  system: string;
  messages: Message[];
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  /** Cancels the in-flight request (and any retry wait) when the caller walks away. */
  signal?: AbortSignal;
}
export interface ConverseResult {
  content: Block[];
  stopReason: string | null;
}

export interface PostOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Base delay for retrying network errors and 408/429/5xx; doubles each attempt, two retries at most. */
  retryBaseMs?: number;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 529]);

/**
 * POSTs a JSON body and returns the parsed JSON answer. Network errors and retryable statuses are tried twice more with
 * back-off; anything else becomes a ModelError carrying the provider's message, never the key or the body.
 */
export async function postJson(url: string, headers: Record<string, string>, body: string, opts: PostOptions, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new ModelError("model request aborted", null);
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
      response = await (opts.fetch ?? fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (cause) {
      if (signal?.aborted) throw new ModelError("model request aborted", null);
      if (attempt < 2) {
        await abortableSleep((opts.retryBaseMs ?? 500) * 2 ** attempt, signal);
        continue;
      }
      throw new ModelError(`model request failed: ${cause instanceof Error ? cause.message : "network error"}`, null);
    }

    if (response.ok) return response.json();
    if (RETRYABLE.has(response.status) && attempt < 2) {
      await abortableSleep((opts.retryBaseMs ?? 500) * 2 ** attempt, signal);
      continue;
    }
    const answer = (await response.json().catch(() => ({}))) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof answer.error === "string" ? answer.error : typeof answer.error?.message === "string" ? answer.error.message : typeof answer.message === "string" ? answer.message : "";
    throw new ModelError(`model API ${response.status}: ${message || response.statusText}`, response.status);
  }
}

/** A retry back-off that ends early, with a ModelError, if the caller aborts. */
async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return Bun.sleep(ms);
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
  await promise;
  if (signal.aborted) throw new ModelError("model request aborted", null);
}
