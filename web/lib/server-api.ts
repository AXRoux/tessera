import { headers } from "next/headers";
import type { z } from "zod";

export type Loaded<T> = { ok: true; data: T } | { ok: false; status: number | null; message: string };

/**
 * Server-side read from the Tessera API. The operator token lives in this process only; the response is parsed with
 * the shared wire schema so a page can never render a shape the API did not promise.
 */
export async function loadFromApi<S extends z.ZodType>(path: string, schema: S): Promise<Loaded<z.infer<S>>> {
  const base = process.env.TESSERA_API_URL;
  const token = process.env.TESSERA_API_TOKEN;
  if (!base || !token) {
    return { ok: false, status: null, message: "The web server has no API token. Set TESSERA_API_TOKEN in the repo root .env (bun run setup writes one), or start both with: bun run demo" };
  }
  const cookie = (await headers()).get("cookie");
  try {
    const response = await fetch(`${base}${path}`, {
      // The visitor's session cookie: in multi-tenant mode it is how the API knows whose workspace this page shows.
      headers: { "x-tessera-token": token, ...(cookie ? { cookie } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { ok: false, status: response.status, message: `The API answered ${response.status}.` };
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) return { ok: false, status: null, message: "The API answered with a shape the web app does not recognize." };
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, status: null, message: `Cannot reach the Tessera API at ${base}. Start it with: bun run demo (offline) or bun run dev` };
  }
}
