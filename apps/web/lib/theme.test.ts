import { describe, expect, it } from "vitest";

import { oppositeTheme, resolveTheme, THEME_STORAGE_KEY } from "./theme";

describe("theme preferences", () => {
  it("keeps an explicit saved preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("uses the operating-system preference when no valid choice was saved", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme("unsupported", false)).toBe("light");
  });

  it("switches between exactly two themes with a stable storage key", () => {
    expect(oppositeTheme("dark")).toBe("light");
    expect(oppositeTheme("light")).toBe("dark");
    expect(THEME_STORAGE_KEY).toBe("aialra-theme");
  });
});
