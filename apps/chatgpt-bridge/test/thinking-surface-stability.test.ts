import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../extension/content-script.js", import.meta.url), "utf8");
const helperSource = source.slice(
  source.indexOf("async function waitForStableThinkingDepthSurface("),
  source.indexOf("function thinkingDepthControl("),
);

function harness(readyAfter: number) {
  let now = 0;
  let reads = 0;
  const wait = runInNewContext(`${helperSource}; waitForStableThinkingDepthSurface`, {
    Date: { now: () => (now += 100) },
    currentSurface: () => (reads >= readyAfter ? "chat" : "unknown"),
    thinkingDepthControl: () => (reads >= readyAfter ? {} : null),
    waitForMutation: async () => {
      reads += 1;
    },
  }) as (deadline: number) => Promise<void>;
  return { wait, reads: () => reads };
}

describe("thinking surface stability", () => {
  it("waits through a transient unknown surface before selecting a depth", async () => {
    const page = harness(3);
    await expect(page.wait(100_000)).resolves.toBeUndefined();
    expect(page.reads()).toBeGreaterThan(3);
  });

  it("fails before any submission if the chat menu never becomes stable", async () => {
    await expect(harness(1_000).wait(100_000)).rejects.toThrow("chatgpt_page_not_ready");
  });
});
