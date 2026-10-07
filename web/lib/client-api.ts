import { z } from "zod";
import { AgentStreamEventSchema, ProblemSchema, type AgentStreamEvent, type Problem } from "../../src/server/wire";

/** A refusal or failure from the API, carrying the sentences the operator needs (reasons, blockers). */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem,
  ) {
    super(problem.message);
    this.name = "ApiProblem";
  }
}

/** Any JSON object: for action endpoints where only success matters. */
export const Acknowledged = z.looseObject({});

/** Calls the same-origin proxy and parses the answer with a wire schema. */
export async function api<S extends z.ZodType>(
  path: string,
  schema: S,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<z.infer<S>> {
  const response = await fetch(`/api/${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ProblemSchema.safeParse(json);
    throw new ApiProblem(
      response.status,
      parsed.success ? parsed.data : { error: "RequestFailed", message: `The request failed (${response.status}).` },
    );
  }
  return schema.parse(json);
}

/**
 * Starts an agent run and hands each step to `onEvent` as it arrives. Resolves when the stream ends. Pass an
 * AbortSignal to walk away mid-run: the server stops the agent at its next step.
 */
export async function streamAgentRun(
  incidentId: string | null,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
  mode: "commander" | "adversary" = "commander",
): Promise<void> {
  const response = await fetch("/api/agent/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(incidentId ? { incidentId } : {}), mode }),
    cache: "no-store",
    signal,
  });
  if (!response.ok || !response.body) {
    const json: unknown = await response.json().catch(() => null);
    const parsed = ProblemSchema.safeParse(json);
    throw new ApiProblem(
      response.status,
      parsed.success ? parsed.data : { error: "RequestFailed", message: `The agent could not start (${response.status}).` },
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue; // a keepalive comment
      const parsed = AgentStreamEventSchema.safeParse(JSON.parse(line.slice(6)));
      if (parsed.success) onEvent(parsed.data);
    }
  }
}
