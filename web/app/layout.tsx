import type { Metadata } from "next";
import { Be_Vietnam_Pro, Fragment_Mono } from "next/font/google";
import { AgentRunProvider } from "@/components/agent/agent-run";
import { FloatingStart } from "@/components/floating-start";
import { Header } from "@/components/header";
import { SiteFooter } from "@/components/site-footer";
import { loadFromApi } from "@/lib/server-api";
import { HealthSchema } from "../../src/server/wire";
import "./globals.css";

const vietnam = Be_Vietnam_Pro({ weight: ["300", "400", "500", "600", "700"], subsets: ["latin"], variable: "--font-vietnam", display: "swap" });
const fragment = Fragment_Mono({ weight: "400", subsets: ["latin"], variable: "--font-fragment", display: "swap" });

export const metadata: Metadata = {
  title: "Tessera. Money that moves once, and can prove it.",
  description:
    "Tessera stops AI agents from paying the same invoice twice. Payout controls, exception handling and reconciliation, built on Airwallex.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The host/origin check runs for every request in proxy.ts, before anything here renders.
  const health = await loadFromApi("/api/health", HealthSchema);
  const offline = health.ok && health.data.offline;
  const tour = health.ok && health.data.sandbox;
  return (
    <html lang="en" className={`${vietnam.variable} ${fragment.variable}`}>
      <body>
        <AgentRunProvider>
          <Header offline={offline} tour={tour} />
          <main>{children}</main>
        </AgentRunProvider>
        <SiteFooter offline={offline} />
        {tour ? <FloatingStart /> : null}
      </body>
    </html>
  );
}
