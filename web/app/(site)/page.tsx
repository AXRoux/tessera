import type { Metadata } from "next";
import { Landing } from "@/components/landing/landing";
import { signedIn } from "@/lib/account";
import { loadFromApi } from "@/lib/server-api";
import { HealthSchema } from "../../../src/server/wire";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Tessera · AI agents you can trust with payouts",
  description:
    "Agentic payout control on Airwallex. Agents read the inbox and chase failed payouts; your policy, written in code, settles what may move; a person signs what matters; and every payout is sealed and proved.",
};

export default async function Home() {
  const accounts = process.env.TESSERA_AUTH === "1";
  // Multi-tenant: whoever is signed in on this browser (the page greets them instead of asking them to sign in again).
  // Signed out there is no workspace to ask about: each person brings their own sandbox.
  const [account, health] = await Promise.all([signedIn(), accounts ? Promise.resolve(null) : loadFromApi("/api/health", HealthSchema)]);
  const rail = accounts ? "byok" : health?.ok && health.data.offline ? "offline" : "sandbox";
  return <Landing accounts={accounts} rail={rail} account={account} />;
}
