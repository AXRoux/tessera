import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { WorkspaceRoom } from "@/components/workspace/workspace-room";
import { loadFromApi } from "@/lib/server-api";
import { WorkspaceResponseSchema } from "../../../../src/server/wire";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Workspace and keys · Tessera" };

export default async function WorkspacePage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const [{ welcome }, workspace] = await Promise.all([searchParams, loadFromApi("/api/workspace", WorkspaceResponseSchema)]);
  if (!workspace.ok) redirect("/sign-in?next=/workspace");
  return <WorkspaceRoom initial={workspace.data} welcome={welcome === "1"} />;
}
