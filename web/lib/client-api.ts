import { z } from "zod";
import { ProblemSchema, type Problem } from "../../src/server/wire";

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
