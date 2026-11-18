import type { Metadata } from "next";
import { RequestsRoom } from "@/components/suppliers/requests-room";
import { loadFromApi } from "@/lib/server-api";
import { HealthSchema, RequestListSchema, SuppliersSchema } from "../../../../src/server/wire";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Requests · Tessera",
  description: "Where a payment starts: a supplier's invoice, checked at the door in code, approved by a person.",
};

export default async function RequestsPage() {
  const [suppliers, requests, health] = await Promise.all([
    loadFromApi("/api/suppliers", SuppliersSchema),
    loadFromApi("/api/requests", RequestListSchema),
    loadFromApi("/api/health", HealthSchema),
  ]);
  return (
    <RequestsRoom
      health={health.ok ? health.data : null}
      initialSuppliers={suppliers.ok ? suppliers.data : null}
      initialRequests={requests.ok ? requests.data.items : []}
    />
  );
}
