import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell";
import { loadFromApi } from "@/lib/server-api";
import { AGENT_FACE_COOKIE, parseFaceChoice } from "@/lib/agent-face";
import { THEME_COOKIE } from "@/lib/theme-cookie";
import { HealthSchema, WorkspaceResponseSchema } from "../../../src/server/wire";

/**
 * Everything the operator does happens inside the shell: the menubar, the search and the live status. In multi-tenant
 * mode the shell also knows who is signed in; a session the API no longer accepts is sent back to sign-in.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = process.env.TESSERA_AUTH === "1";
  const [health, jar, workspace] = await Promise.all([
    loadFromApi("/api/health", HealthSchema),
    cookies(),
    auth ? loadFromApi("/api/workspace", WorkspaceResponseSchema) : Promise.resolve(null),
  ]);
  if (auth && (workspace?.ok === false && workspace.status === 401)) redirect("/sign-in");
  const theme = jar.get(THEME_COOKIE)?.value === "dark" ? "dark" : "light";
  const agentFace = parseFaceChoice(jar.get(AGENT_FACE_COOKIE)?.value);
  return (
    <AppShell health={health.ok ? health.data : null} theme={theme} agentFace={agentFace} account={workspace?.ok ? { ...workspace.data.user, mode: workspace.data.workspace.mode } : null}>
      {children}
    </AppShell>
  );
}
