import { FloatingStart } from "@/components/floating-start";
import { Header } from "@/components/header";
import { SiteFooter } from "@/components/site-footer";
import { loadFromApi } from "@/lib/server-api";
import { HealthSchema } from "../../../src/server/wire";

/**
 * The marketing side of the site: the header, the footer and the pill that follows a visitor down the page.
 * The dashboard and the incident pages use the app shell in `(app)` instead.
 */
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  // The host/origin check runs for every request in proxy.ts, before anything here renders.
  const health = await loadFromApi("/api/health", HealthSchema);
  const offline = health.ok && health.data.offline;
  const tour = health.ok && health.data.sandbox;
  return (
    <>
      <Header offline={offline} tour={tour} />
      <main>{children}</main>
      <SiteFooter offline={offline} />
      {tour ? <FloatingStart /> : null}
    </>
  );
}
