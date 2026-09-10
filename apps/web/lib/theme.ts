export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "aialra-theme";

export function resolveTheme(storedTheme: string | null, prefersDark: boolean): Theme {
  if (storedTheme === "light" || storedTheme === "dark") return storedTheme;
  return prefersDark ? "dark" : "light";
}

export function oppositeTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}
