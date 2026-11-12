import { AppShell } from "@/components/shell";
import { loadFromApi } from "@/lib/server-api";
import { HealthSchema } from "../../../src/server/wire";

/** Everything the operator does happens inside the shell: the rail, the search and the live status pills. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const health = await loadFromApi("/api/health", HealthSchema);
  return <AppShell health={health.ok ? health.data : null}>{children}</AppShell>;
}
