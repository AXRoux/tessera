import type { Metadata } from "next";
import { AccountAuthScreen } from "@/components/auth/auth-screen";
import { signedIn } from "@/lib/account";

export const metadata: Metadata = { title: "Create your workspace · Tessera" };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <AccountAuthScreen mode="sign-up" next={next ?? null} initial={await signedIn()} />;
}
