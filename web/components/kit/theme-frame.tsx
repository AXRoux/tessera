"use client";

import type { ReactNode } from "react";
import { ThemeProvider, type Theme } from "./theme";

/** A page outside the app shell (the landing, sign-in) on the same desk and palette, in the theme the person last chose. */
export function ThemeFrame({ theme, className = "", children }: { theme: Theme; className?: string; children: ReactNode }) {
  return (
    <ThemeProvider initial={theme}>
      {(current) => (
        <div data-theme={current} className={`desk font-ui antialiased ${className}`}>
          {children}
        </div>
      )}
    </ThemeProvider>
  );
}
