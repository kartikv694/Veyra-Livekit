"use client";

/**
 * Light/dark theme context.
 *
 * On mount, resolves the initial theme from localStorage (if the user has
 * toggled before) or the OS's `prefers-color-scheme`, then applies it by
 * toggling a `.dark` class on `<html>` — Tailwind's `dark:` variant and the
 * CSS custom properties in globals.css both key off that class. `toggle()`
 * flips the theme and persists the choice so it survives a reload.
 */
import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "light",
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");

  // localStorage/matchMedia are browser-only — this has to be an
  // effect (not a useState lazy initializer) to avoid a hydration
  // mismatch between server and client markup, same reasoning as the
  // ?email=/?reason= mount effects elsewhere in the app. Empty deps
  // means it runs exactly once, so there's no cascade risk despite the
  // synchronous setState the linter is generally right to be wary of.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const stored = window.localStorage.getItem("theme") as Theme | null;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const initial = stored ?? (prefersDark ? "dark" : "light");
    setTheme(initial);
    document.documentElement.classList.toggle("dark", initial === "dark");
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const toggle = () => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      document.documentElement.classList.toggle("dark", next === "dark");
      window.localStorage.setItem("theme", next);
      return next;
    });
  };

  return (
    <ThemeContext.Provider value={{ theme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
