import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountAuthScreen, AuthScreen } from "@/components/auth/auth-screen";
import { signedIn } from "@/lib/account";
import { safeNext } from "@/lib/safe-next";

export const metadata: Metadata = { title: "Sign in · Tessera" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // One operator, no accounts: the same screen, as the door to that operator's control room.
  if (process.env.TESSERA_AUTH !== "1") return <AuthScreen mode="operator" next={next ?? null} />;
  const account = await signedIn();
  // Sent here on the way to a page, but the session is good after all: go straight there.
  if (account && next) redirect(safeNext(next, "/dashboard"));
  return <AccountAuthScreen mode="sign-in" next={next ?? null} initial={account} />;
}
