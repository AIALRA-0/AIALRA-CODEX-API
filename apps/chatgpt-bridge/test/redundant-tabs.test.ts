import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

function harness(pages: Record<number, Record<string, unknown>>) {
  const source = readFileSync(new URL("../extension/service-worker.js", import.meta.url), "utf8");
  const remove = vi.fn(async () => undefined);
  const activeJobs = new Map();
  const slots = new Map([["managed", { slotId: "managed", tabId: 1, state: "idle" }]]);
  const closeRedundantPristineTabs = runInNewContext(
    `${source.slice(
      source.indexOf("async function closeRedundantPristineTabs("),
      source.indexOf("async function resetSlot("),
    )}; closeRedundantPristineTabs`,
    {
      activeJobs,
      slots,
      CHATGPT_URL: "https://chatgpt.com/",
      sendToTab: async (tabId: number) => pages[tabId] ?? null,
      chrome: {
        tabs: {
          query: async () => [
            { id: 1, active: false },
            { id: 2, active: false },
            { id: 3, active: true },
            { id: 4, active: false },
          ],
          remove,
        },
      },
    },
  ) as () => Promise<void>;
  return { closeRedundantPristineTabs, remove, activeJobs };
}

const pristinePage = {
  authenticated: true,
  failureCode: null,
  diagnostics: {
    freshConversation: true,
    userTurnCount: 0,
    assistantTurnCount: 0,
    composerTextLength: 0,
    generationActive: false,
  },
};

describe("redundant ChatGPT tabs", () => {
  it("closes only an unmanaged background tab that is proven empty", async () => {
    const h = harness({
      2: pristinePage,
      3: pristinePage,
      4: { ...pristinePage, authenticated: false, failureCode: "chatgpt_login_required" },
    });

    await h.closeRedundantPristineTabs();

    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.remove).toHaveBeenCalledWith(2);
  });

  it("does not close any tab while a task is active", async () => {
    const h = harness({ 2: pristinePage });
    h.activeJobs.set("job", "managed");

    await h.closeRedundantPristineTabs();

    expect(h.remove).not.toHaveBeenCalled();
  });
});
