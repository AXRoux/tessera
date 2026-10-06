import type { Metadata } from "next";
import { Archivo, JetBrains_Mono, Zen_Dots } from "next/font/google";
import { Header } from "@/components/header";
import "./globals.css";

const zen = Zen_Dots({ weight: "400", subsets: ["latin"], variable: "--font-zen", display: "swap" });
const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "PayOnce: pay once, whatever the agent does",
  description:
    "An exactly-once payout gateway, incident commander and closer for agents that move money on Airwallex.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${zen.variable} ${archivo.variable} ${mono.variable}`}>
      <body>
        <Header />
        <main>{children}</main>
        <footer className="mx-auto mt-24 flex max-w-[1440px] items-center justify-between border-t border-rule px-6 py-8 sm:px-10">
          <span className="label">PayOnce / Airwallex sandbox only</span>
          <span className="label hidden sm:inline">No real money moves</span>
        </footer>
      </body>
    </html>
  );
}
