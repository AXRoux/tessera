import type { Metadata } from "next";
import { Archivo, Be_Vietnam_Pro, Fragment_Mono, IBM_Plex_Mono, Inter } from "next/font/google";
import { AgentRunProvider } from "@/components/agent/agent-run";
import "./globals.css";

const vietnam = Be_Vietnam_Pro({ weight: ["300", "400", "500", "600", "700"], subsets: ["latin"], variable: "--font-vietnam", display: "swap" });
const fragment = Fragment_Mono({ weight: "400", subsets: ["latin"], variable: "--font-fragment", display: "swap" });
/** The control room's voice: Inter for words, IBM Plex Mono for every figure, readout and reference. */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
/** The landing's poster voice: Archivo with its width axis, set condensed and opened up as it lands. */
const archivo = Archivo({ weight: "variable", axes: ["wdth"], subsets: ["latin"], variable: "--font-archivo", display: "swap" });
const plex = IBM_Plex_Mono({ weight: ["400", "500"], subsets: ["latin"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Tessera. Money that moves once, and can prove it.",
  description:
    "Tessera stops AI agents from paying the same invoice twice. Payout controls, exception handling and reconciliation, built on Airwallex.",
};

/**
 * The one layout under everything: fonts, the page shell and the single agent run the whole app shares, so moving
 * between the board and an incident page never cancels a run. The chrome per world lives in `(site)` and `(app)`.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${vietnam.variable} ${fragment.variable} ${inter.variable} ${plex.variable} ${archivo.variable}`}>
      <body>
        <AgentRunProvider>{children}</AgentRunProvider>
      </body>
    </html>
  );
}
