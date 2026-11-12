import type { Metadata } from "next";
import { AuthScreen } from "@/components/auth/auth-screen";

export const metadata: Metadata = { title: "Sign in · Tessera" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // One operator, no accounts: the same screen, as the door to that operator's control room.
  return <AuthScreen mode={process.env.TESSERA_AUTH === "1" ? "sign-in" : "operator"} next={next ?? null} />;
}
