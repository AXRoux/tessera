import { cookies } from "next/headers";
import { AuthFrame } from "@/components/auth/auth-frame";
import { THEME_COOKIE } from "@/lib/theme-cookie";

/** Sign-in and sign-up sit on the same desk as the control room, in the palette the person last chose. */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get(THEME_COOKIE)?.value === "dark" ? "dark" : "light";
  return <AuthFrame theme={theme}>{children}</AuthFrame>;
}
