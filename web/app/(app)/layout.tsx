import { cookies } from "next/headers";
import { AppShell } from "@/components/shell";
import { THEME_COOKIE } from "@/lib/theme-cookie";
import { loadFromApi } from "@/lib/server-api";
import { HealthSchema } from "../../../src/server/wire";

/** Everything the operator does happens inside the shell: the menubar, the search and the live status. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [health, jar] = await Promise.all([loadFromApi("/api/health", HealthSchema), cookies()]);
  const theme = jar.get(THEME_COOKIE)?.value === "dark" ? "dark" : "light";
  return (
    <AppShell health={health.ok ? health.data : null} theme={theme}>
      {children}
    </AppShell>
  );
}
