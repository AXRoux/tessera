import { getSessionCookie } from "better-auth/cookies";
import { headers } from "next/headers";
import { WorkspaceResponseSchema } from "../../src/server/wire";
import { loadFromApi } from "./server-api";
import type { SignedIn } from "./use-account";

/**
 * Who is signed in on this request, as the API sees it (multi-tenant mode only). No session cookie, no call; a cookie
 * the API no longer accepts (expired, signed out elsewhere) counts as signed out.
 */
export async function signedIn(): Promise<SignedIn | null> {
  if (process.env.TESSERA_AUTH !== "1") return null;
  if (!getSessionCookie(await headers())) return null;
  const workspace = await loadFromApi("/api/workspace", WorkspaceResponseSchema);
  return workspace.ok ? { name: workspace.data.user.name, email: workspace.data.user.email } : null;
}
