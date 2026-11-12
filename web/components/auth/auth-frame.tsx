"use client";

import type { ReactNode } from "react";
import { ThemeProvider, type Theme } from "../kit/theme";

export function AuthFrame({ theme, children }: { theme: Theme; children: ReactNode }) {
  return (
    <ThemeProvider initial={theme}>
      {(current) => (
        <div data-theme={current} className="desk min-h-dvh font-ui antialiased xl:h-dvh xl:min-h-[640px]">
          {children}
        </div>
      )}
    </ThemeProvider>
  );
}
