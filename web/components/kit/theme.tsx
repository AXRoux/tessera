"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { THEME_COOKIE } from "@/lib/theme-cookie";

export type Theme = "light" | "dark";

interface ThemeState {
  theme: Theme;
  setTheme: (next: Theme) => void;
}

const ThemeContext = createContext<ThemeState>({ theme: "light", setTheme: () => undefined });
/** True inside an `.inverse` tile: the palette is flipped there, and anything that renders its own material (metal) must know. */
const InvertContext = createContext(false);


/**
 * The app's light/dark switch. The server reads the cookie, so the first paint is already in the right palette; the
 * client writes it back on every change. The palette itself is CSS: `data-theme` on the shell root swaps every variable.
 */
export function ThemeProvider({ initial, children }: { initial: Theme; children: (theme: Theme) => ReactNode }) {
  const [theme, set] = useState<Theme>(initial);
  const setTheme = useCallback((next: Theme) => {
    set(next);
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  }, []);
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children(theme)}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}

/** The palette a component is actually sitting on: the app's, flipped inside an inverted tile. */
export function useSurface(): Theme {
  const { theme } = useContext(ThemeContext);
  const inverted = useContext(InvertContext);
  return inverted ? (theme === "light" ? "dark" : "light") : theme;
}

/** Marks a subtree as sitting on an inverted tile. Pair with the `inverse` class on the same element. */
export function Inverted({ children }: { children: ReactNode }) {
  return <InvertContext.Provider value={true}>{children}</InvertContext.Provider>;
}
