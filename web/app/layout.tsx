import type { Metadata } from "next";
import { Archivo, JetBrains_Mono, Zen_Dots } from "next/font/google";
import { AgentRunProvider } from "@/components/agent/agent-run";
import { Header } from "@/components/header";
import { Logo } from "@/components/logo";
import { loadFromApi } from "@/lib/server-api";
import { HealthSchema } from "../../src/server/wire";
import "./globals.css";

const zen = Zen_Dots({ weight: "400", subsets: ["latin"], variable: "--font-zen", display: "swap" });
const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Tessera. Money that moves once, and can prove it.",
  description:
    "Tessera stops AI agents from paying the same invoice twice. Payout controls, exception handling and reconciliation, built on Airwallex.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The host/origin check runs for every request in proxy.ts, before anything here renders.
  const health = await loadFromApi("/api/health", HealthSchema);
  const offline = health.ok && health.data.offline;
  return (
    <html lang="en" className={`${zen.variable} ${archivo.variable} ${mono.variable}`}>
      <body>
        <AgentRunProvider>
          <Header offline={offline} />
          <main>{children}</main>
        </AgentRunProvider>
        <footer className="mx-auto mt-24 flex max-w-[1440px] items-center justify-between border-t border-rule px-6 py-8 sm:px-10">
          <span className="flex items-center gap-3">
            <Logo size={20} />
            <span className="label">{offline ? "Tessera / Offline demo on a simulated Airwallex" : "Tessera / Built on the Airwallex sandbox"}</span>
          </span>
          <span className="label hidden sm:inline">No real money moves</span>
        </footer>
      </body>
    </html>
  );
}
