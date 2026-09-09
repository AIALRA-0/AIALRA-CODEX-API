import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { ExtensionFailedSchema } from "../src/protocol.js";
import { fixedBridgeError } from "../src/core.js";

const source = readFileSync(new URL("../extension/content-script.js", import.meta.url), "utf8");
function modeSelection(menuVisible: boolean, optionFound = false) {
  const tools = {};
  const nativeClick = vi.fn();
  const configureMode = runInNewContext(
    `${source.slice(source.indexOf("async function configureMode("), source.indexOf("function temporaryChatControls("))}; configureMode`,
    {
      first: () => tools,
      SELECTORS: { tools: [], composer: [] },
      nativeClick,
      buttonByText: () => (menuVisible ? {} : null),
      waitForButtonByText: async () => (optionFound ? {} : null),
      setTimeout: (callback: () => void) => callback(),
      composerControlRoot: () => ({}),
      visibleText: () => "Deep research",
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
