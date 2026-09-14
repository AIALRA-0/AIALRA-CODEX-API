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

  it("allows a slow but eventually ready Temporary Chat control before sending", async () => {
    const page = harness(120);
    await expect(page.wait(100_000)).resolves.toBeUndefined();
    expect(page.reads()).toBeGreaterThan(120);
  });

  it("accepts a Temporary Chat depth control when Chat/Work tabs are absent", async () => {
    let now = 0;
    const wait = runInNewContext(`${helperSource}; waitForStableThinkingDepthSurface`, {
      Date: { now: () => (now += 100) },
      currentSurface: () => "unknown",
      thinkingDepthControl: () => ({ label: "Extra High" }),
      waitForMutation: async () => {},
    }) as (deadline: number) => Promise<void>;
    await expect(wait(100_000)).resolves.toBeUndefined();
  });

  it("does not treat a selected Work tab as a Chat depth surface", async () => {
    let now = 0;
    const wait = runInNewContext(`${helperSource}; waitForStableThinkingDepthSurface`, {
      Date: { now: () => (now += 100) },
      currentSurface: () => "work",
      thinkingDepthControl: () => ({ label: "Extra High" }),
      waitForMutation: async () => {},
    }) as (deadline: number) => Promise<void>;
    await expect(wait(100_000)).rejects.toThrow("chatgpt_page_not_ready");
  });

  it("does not require a depth control for Auto chat", async () => {
    const requestedSource = source.slice(
      source.indexOf("async function waitForRequestedThinkingDepthSurface("),
      source.indexOf("function thinkingDepthControl("),
    );
    let waits = 0;
    const wait = runInNewContext(`${requestedSource}; waitForRequestedThinkingDepthSurface`, {
      waitForStableThinkingDepthSurface: async () => {
        waits += 1;
      },
    }) as (invocation: { mode: string; thinkingDepth?: string }, deadline: number) => Promise<void>;
    await expect(wait({ mode: "chat" }, Date.now() + 1_000)).resolves.toBeUndefined();
    expect(waits).toBe(0);
    await expect(
      wait({ mode: "chat", thinkingDepth: "High" }, Date.now() + 1_000),
    ).resolves.toBeUndefined();
    expect(waits).toBe(1);
  });

  it("fails before any submission if the chat menu never becomes stable", async () => {
    await expect(harness(1_000).wait(100_000)).rejects.toThrow("chatgpt_page_not_ready");
  });

  it("rechecks a control that briefly vanished after the surface became stable", async () => {
    const configureSource = source.slice(
      source.indexOf("async function configureThinkingDepth("),
      source.indexOf("function buttonByText("),
    );
    let controlPresent = false;
    let waits = 0;
    const configure = runInNewContext(`${configureSource}; configureThinkingDepth`, {
      thinkingDepthControl: () => (controlPresent ? { isConnected: true } : null),
      waitForStableThinkingDepthSurface: async () => {
        waits += 1;
        controlPresent = true;
      },
      visibleText: () => "6 Pro",
      openThinkingDepthMenu: async () => ({}),
      clickThinkingDepthControl: async () => {},
      thinkingDepthSlider: () => null,
      readThinkingDepthChoices: async () => [{ label: "6 Pro", selected: true }],
      closeThinkingDepthMenu: async () => {},
      setTimeout: (callback: () => void) => callback(),
      thinkingDepthDiscoveryDiagnostics: null,
    }) as (invocation: { thinkingDepth: string }, deadline: number) => Promise<string>;
    await expect(configure({ thinkingDepth: "6 Pro" }, Date.now() + 20_000)).resolves.toBe("6 Pro");
    expect(waits).toBe(1);
  });
});
