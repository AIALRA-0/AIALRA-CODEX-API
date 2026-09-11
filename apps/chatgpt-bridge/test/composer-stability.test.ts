import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../extension/content-script.js", import.meta.url), "utf8");

function stabilityHarness(elements: object[]) {
  let now = 0;
  let index = 0;
  const waitForStableComposer = runInNewContext(
    `${source.slice(
      source.indexOf("async function waitForStableComposer("),
      source.indexOf("async function nativeSetComposerText("),
    )}; waitForStableComposer`,
    {
      Date: { now: () => now },
      SELECTORS: { composer: [] },
      first: () => elements[Math.min(index, elements.length - 1)],
      waitForMutation: async () => {
        now += 250;
        index += 1;
      },
    },
  );
  return { waitForStableComposer, now: () => now };
}

function composer(top: number) {
  return {
    getBoundingClientRect: () => ({ left: 100, top, width: 600, height: 48 }),
  };
}

describe("composer stability", () => {
  it("waits for the replacement editor to remain stable before native input", async () => {
    const firstComposer = composer(300);
    const replacement = composer(340);
    const harness = stabilityHarness([firstComposer, replacement]);

    await expect(harness.waitForStableComposer(10_000, 1_000)).resolves.toBe(replacement);
    expect(harness.now()).toBeGreaterThanOrEqual(1_250);
  });

  it("rejects an editor that keeps moving until the stability deadline", async () => {
    const moving = Array.from({ length: 50 }, (_, index) => composer(300 + index));
    const harness = stabilityHarness(moving);

    await expect(harness.waitForStableComposer(2_000, 1_000)).rejects.toThrow(
      "chatgpt_page_not_ready",
    );
  });
});
