import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { ExtensionFailedSchema } from "../src/protocol.js";
import { fixedBridgeError } from "../src/core.js";

const source = readFileSync(new URL("../extension/content-script.js", import.meta.url), "utf8");
function modeSelection(menuVisible: boolean, optionFound = false, visibleLabel = "Deep research") {
  const tools = {};
  const nativeClick = vi.fn();
  const configureMode = runInNewContext(
    `${source.slice(source.indexOf("async function configureMode("), source.indexOf("function temporaryChatControls("))}; configureMode`,
    {
      first: () => tools,
      SELECTORS: { tools: [], composer: [] },
      nativeClick,
      buttonByText: () => (menuVisible ? {} : null),
      waitForStableButtonByText: async () => (optionFound ? {} : null),
      setTimeout: (callback: () => void) => callback(),
      composerControlRoot: () => ({}),
      visibleText: () => visibleLabel,
      waitForMutation: async () => {},
    },
  );
  return { configureMode, nativeClick };
}

describe("Temporary Chat mode availability", () => {
  it("reports a missing research capability only when the tools menu is recognizable", async () => {
    const { configureMode, nativeClick } = modeSelection(true);
    await expect(configureMode("deep_research", "synthetic", Date.now() + 10_000)).rejects.toThrow(
      "chatgpt_mode_unavailable",
    );
    expect(nativeClick).toHaveBeenCalledTimes(1);
  });
  it("keeps an unrecognized menu classified as a UI change", async () => {
    await expect(
      modeSelection(false).configureMode("deep_research", "synthetic", Date.now() + 10_000),
    ).rejects.toThrow("chatgpt_ui_changed");
  });
  it("still selects and verifies research when the menu offers it", async () => {
    const { configureMode, nativeClick } = modeSelection(true, true);
    await expect(
      configureMode("deep_research", "synthetic", Date.now() + 10_000),
    ).resolves.toBeUndefined();
    expect(nativeClick).toHaveBeenCalledTimes(2);
  });
  it("accepts the short Search label after selecting the stable tools-menu row", async () => {
    const { configureMode, nativeClick } = modeSelection(true, true, "Search");
    await expect(
      configureMode("search", "synthetic", Date.now() + 10_000),
    ).resolves.toBeUndefined();
    expect(nativeClick).toHaveBeenCalledTimes(2);
  });
  it("excludes a Search control that existed before the tools menu opened", async () => {
    const tools = {};
    const sidebarSearch = {};
    const menuSearch = {};
    const nativeClick = vi.fn();
    const waitForStableButtonByText = vi.fn(async (_pattern, _deadline, excluded) => {
      expect(excluded).toBe(sidebarSearch);
      return menuSearch;
    });
    const configureMode = runInNewContext(
      `${source.slice(source.indexOf("async function configureMode("), source.indexOf("function temporaryChatControls("))}; configureMode`,
      {
        first: () => tools,
        SELECTORS: { tools: [], composer: [] },
        nativeClick,
        buttonByText: () => sidebarSearch,
        waitForStableButtonByText,
        setTimeout: (callback: () => void) => callback(),
        composerControlRoot: () => ({}),
        visibleText: () => "Search",
        waitForMutation: async () => {},
      },
    );

    await expect(
      configureMode("search", "synthetic", Date.now() + 10_000),
    ).resolves.toBeUndefined();
    expect(waitForStableButtonByText).toHaveBeenCalledTimes(1);
    expect(nativeClick).toHaveBeenNthCalledWith(1, tools, "synthetic", "tools_menu");
    expect(nativeClick).toHaveBeenNthCalledWith(2, menuSearch, "synthetic", "mode_option");
  });
  it("carries the specific safe error through the bridge protocol", () => {
    expect(
      ExtensionFailedSchema.safeParse({
        type: "failed",
        jobId: "00000000-0000-4000-8000-000000000001",
        code: "chatgpt_mode_unavailable",
        message: "mode unavailable",
      }).success,
    ).toBe(true);
    expect(fixedBridgeError("chatgpt_mode_unavailable")).toContain("任务未发送");
  });
});
