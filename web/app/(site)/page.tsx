import type { Metadata } from "next";
import { Landing } from "@/components/landing/landing";
import { loadFromApi } from "@/lib/server-api";
import { HealthSchema } from "../../../src/server/wire";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Tessera · AI agents you can trust with payouts",
  description:
    "Agentic payout control on Airwallex. AI agents do the legwork, policy in code decides what may move, a person signs what matters, and every payout is sealed and proved.",
};

export default async function Home() {
  const accounts = process.env.TESSERA_AUTH === "1";
  // Signed-out on the multi-tenant host there is no workspace to ask: each person brings their own sandbox.
  const health = accounts ? null : await loadFromApi("/api/health", HealthSchema);
  const rail = accounts ? "byok" : health?.ok && health.data.offline ? "offline" : "sandbox";
  return <Landing accounts={accounts} rail={rail} />;
}
