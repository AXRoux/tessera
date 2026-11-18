import type { Metadata } from "next";
import { RequestsRoom } from "@/components/suppliers/requests-room";
import { loadFromApi } from "@/lib/server-api";
import { HealthSchema, RequestListSchema, SuppliersSchema } from "../../../../src/server/wire";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payables · Tessera",
  description: "Suppliers waiting on payment: each invoice verified on receipt, approved by a person, paid once.",
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
