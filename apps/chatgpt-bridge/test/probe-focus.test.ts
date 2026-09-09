import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function harness() {
  let activeTab = 1;
  const activeJobs = new Map();
  const slot = { tabId: 2, state: "idle" };
  const page = {
    pageReady: true,
    authenticated: true,
    failureCode: null,
    diagnostics: { freshConversation: true },
    models: [],
  };
  const sendToTab = vi.fn(async (_id: number, message: { discoverModels: boolean }) => {
    return message.discoverModels ? { ...page, models: [{ id: "chatgpt-web.auto" }] } : page;
  });
  const update = vi.fn(async (id: number) => {
    activeTab = id;
  });
  const source = readFileSync(new URL("../extension/service-worker.js", import.meta.url), "utf8");
  const probeSlot = runInNewContext(
    `${source.slice(source.indexOf("async function probeSlot("), source.indexOf("async function probe(discoverModels"))}; probeSlot`,
    {
      activeJobs,
      sendToTab,
      chrome: {
        tabs: {
          get: async () => ({ windowId: 10 }),
          query: async () => [{ id: activeTab }],
          update,
        },
      },
    },
  );
  return {
    slot,
    page,
    activeJobs,
    sendToTab,
    update,
    probeSlot,
    chooseTab: (id: number) => {
      activeTab = id;
    },
  };
}

describe("foreground-only model discovery", () => {
  it("activates the fresh system page and restores the administrator tab, with a one-minute cache", async () => {
    const h = harness();
    expect((await h.probeSlot(h.slot, true)).models).toHaveLength(1);
    expect(h.update.mock.calls.map(([id]) => id)).toEqual([2, 1]);
    expect(h.sendToTab.mock.calls.map(([, request]) => request.discoverModels)).toEqual([
      false,
      true,
    ]);
    await h.probeSlot(h.slot, true);
    expect(h.update).toHaveBeenCalledTimes(2);
  });
  it.each(["login", "nonempty", "active"])("never interrupts %s", async (condition) => {
    const h = harness();
    if (condition === "login") h.page.authenticated = false;
    if (condition === "nonempty") h.page.diagnostics.freshConversation = false;
    if (condition === "active") h.activeJobs.set("job", {});
    await h.probeSlot(h.slot, true);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.sendToTab.mock.calls.map(([, request]) => request.discoverModels)).toEqual([false]);
  });
  it.each(["job", "administrator"])("does not restore over a new %s action", async (kind) => {
    const h = harness();
    h.sendToTab.mockImplementation(async (_id, message) => {
      if (message.discoverModels) {
        if (kind === "job") h.activeJobs.set("new-job", {});
        else h.chooseTab(3);
      }
      return h.page;
    });
    await h.probeSlot(h.slot, true);
    expect(h.update.mock.calls.map(([id]) => id)).toEqual([2]);
  });
});
