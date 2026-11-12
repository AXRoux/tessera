import { cookies } from "next/headers";
import { ThemeFrame } from "@/components/kit/theme-frame";
import { THEME_COOKIE } from "@/lib/theme-cookie";

/** Sign-in and sign-up sit on the same desk as the control room, in the palette the person last chose. */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get(THEME_COOKIE)?.value === "dark" ? "dark" : "light";
  return (
    <ThemeFrame theme={theme} className="min-h-dvh xl:h-dvh xl:min-h-[640px]">
      {children}
    </ThemeFrame>
  );
}
