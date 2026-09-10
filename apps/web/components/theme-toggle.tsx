"use client";

import { useEffect, useState } from "react";

import { oppositeTheme, resolveTheme, THEME_STORAGE_KEY, type Theme } from "../lib/theme";

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const activeTheme = resolveTheme(
      window.localStorage.getItem(THEME_STORAGE_KEY),
      window.matchMedia("(prefers-color-scheme: dark)").matches,
    );
    applyTheme(activeTheme);
    setTheme(activeTheme);
  }, []);

  function toggleTheme() {
    const nextTheme = oppositeTheme(theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    applyTheme(nextTheme);
    setTheme(nextTheme);
  }

  const nextThemeLabel = theme === "dark" ? "白色" : "黑色";

  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={`切换为${nextThemeLabel}主题`}
      aria-pressed={theme === "dark"}
      title={`切换为${nextThemeLabel}主题`}
      onClick={toggleTheme}
    >
      <span className="theme-toggle-symbol" aria-hidden="true">
        <span />
      </span>
      <span className="theme-toggle-label">黑 / 白</span>
    </button>
  );
}
