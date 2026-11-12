import { cookies } from "next/headers";
import { ThemeFrame } from "@/components/kit/theme-frame";
import { THEME_COOKIE } from "@/lib/theme-cookie";

/** The public side of the site: one page, on the same desk and palette as the console. */
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get(THEME_COOKIE)?.value === "dark" ? "dark" : "light";
  return <ThemeFrame theme={theme}>{children}</ThemeFrame>;
}
