import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const recoverySource = source.slice(
  source.indexOf("function manualRecoveryState("),
  source.indexOf("function pageFailurePriority("),
);
const navigationSource = source.slice(
  source.indexOf("async function navigateToFreshChat("),
  source.indexOf("async function clearComposerDraft("),
);

const readyPage = {
  pageReady: true,
  authenticated: true,
  failureCode: null,
  diagnostics: {
    pageKind: "home",
    documentToken: "fresh-document",
    userTurnCount: 0,
    assistantTurnCount: 0,
    composerTextLength: 0,
    generationActive: false,
  },
};

type TestSlot = {
  slotId: string;
  tabId: number;
  state: string;
  resetPromise: Promise<unknown> | null;
  resetBackoffUntil?: string;
  resetFailureCount?: number;
};

function recoveryHarness() {
  const slot: TestSlot = {
    slotId: "slot",
    tabId: 1,
    state: "starting",
    resetPromise: null,
  };
  const slots = new Map([["slot", slot]]);
  const activeJobs = new Map();
  const navigateToFreshChat = vi.fn<() => Promise<string | null>>(async () => null);
  const waitForReadyPage = vi.fn(async () => readyPage);
  let currentPage: Record<string, unknown> = readyPage;
  const sendToTab = vi.fn(async () => currentPage);
  const patchSlot = vi.fn(async (_slot: TestSlot, patch: Record<string, unknown>) => {
    Object.assign(slot, patch);
  });
  const context = {
    slot,
    slots,
    activeJobs,
    navigateToFreshChat,
    waitForReadyPage,
    sendToTab,
    patchSlot,
    RESET_BACKOFF_INITIAL_MS: 30_000,
    RESET_BACKOFF_MAX_MS: 5 * 60_000,
    poolMutation: Promise.resolve(),
    restoreSlots: async () => undefined,
    createSlot: async () => undefined,
    closeRedundantPristineTabs: async () => undefined,
    clearComposerDraft: async () => undefined,
    chrome: { tabs: { update: async () => undefined, remove: async () => undefined } },
    setTimeout,
    console,
  };
  const functions = runInNewContext(
    `${recoverySource}; ({ resetSlot, resetSlotUntilReady, ensurePool, probeSlot })`,
    context,
  ) as {
    resetSlot: (currentSlot: TestSlot) => Promise<typeof readyPage>;
    resetSlotUntilReady: (currentSlot: TestSlot) => Promise<boolean>;
    ensurePool: () => Promise<void>;
    probeSlot: (currentSlot: TestSlot, discoverModels: boolean) => Promise<typeof readyPage>;
  };
  return {
    slot,
    functions,
    navigateToFreshChat,
    waitForReadyPage,
    sendToTab,
    patchSlot,
    setPage: (page: Record<string, unknown>) => {
      currentPage = page;
    },
  };
}

describe("browser login recovery", () => {
  it("stops reset navigation after a login failure and stays on the login page", async () => {
    const h = recoveryHarness();
    h.navigateToFreshChat.mockRejectedValue(new Error("chatgpt_login_required"));

    expect(await h.functions.resetSlotUntilReady(h.slot)).toBe(false);
    expect(h.slot.state).toBe("login_required");
    expect(h.navigateToFreshChat).toHaveBeenCalledOnce();

    for (let probe = 0; probe < 20; probe += 1) await h.functions.ensurePool();
    h.setPage({ pageReady: false, authenticated: false, failureCode: "chatgpt_login_required" });
    await h.functions.probeSlot(h.slot, false);
    expect(h.navigateToFreshChat).toHaveBeenCalledOnce();
  });

  it("recovers only after the managed page is authenticated and empty", async () => {
    const h = recoveryHarness();
    h.slot.state = "login_required";
    h.setPage({ ...readyPage, diagnostics: { ...readyPage.diagnostics, composerTextLength: 8 } });
    await h.functions.probeSlot(h.slot, false);
    expect(h.navigateToFreshChat).not.toHaveBeenCalled();

    h.setPage(readyPage);
    const recovered = await h.functions.probeSlot(h.slot, false);
    expect(recovered).toEqual(readyPage);
    expect(h.slot.state).toBe("idle");
    expect(h.navigateToFreshChat).toHaveBeenCalledOnce();
  });

  it("does not reload a verification challenge repeatedly", async () => {
    const h = recoveryHarness();
    h.navigateToFreshChat.mockRejectedValue(new Error("chatgpt_verification_required"));
    expect(await h.functions.resetSlotUntilReady(h.slot)).toBe(false);
    expect(h.slot.state).toBe("quarantined");
    await h.functions.ensurePool();
    expect(h.navigateToFreshChat).toHaveBeenCalledOnce();
  });

  it("backs off after a transient reset failure instead of entering a refresh storm", async () => {
    const h = recoveryHarness();
    h.navigateToFreshChat.mockRejectedValueOnce(new Error("chatgpt_browser_unavailable"));
    expect(await h.functions.resetSlotUntilReady(h.slot)).toBe(false);
    expect(h.slot.state).toBe("starting");
    expect(Date.parse(h.slot.resetBackoffUntil ?? "")).toBeGreaterThan(Date.now());
    for (let probe = 0; probe < 20; probe += 1) await h.functions.ensurePool();
    expect(h.navigateToFreshChat).toHaveBeenCalledOnce();

    Object.assign(h.slot, { resetBackoffUntil: new Date(0).toISOString() });
    await h.functions.ensurePool();
    expect(h.navigateToFreshChat).toHaveBeenCalledTimes(2);
    expect(h.slot.state).toBe("idle");
  });

  it("shares one reset across concurrent probes", async () => {
    const h = recoveryHarness();
    let release!: (value: string) => void;
    h.navigateToFreshChat.mockImplementation(
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    const first = h.functions.resetSlot(h.slot);
    const second = h.functions.resetSlot(h.slot);
    await vi.waitFor(() => expect(h.navigateToFreshChat).toHaveBeenCalledOnce());
    release("old-document");
    await Promise.all([first, second]);
    expect(h.navigateToFreshChat).toHaveBeenCalledOnce();
  });
});

describe("fresh-chat navigation", () => {
  it("does not navigate away from an explicit login screen", async () => {
    const update = vi.fn();
    const reload = vi.fn();
    const navigateToFreshChat = runInNewContext(`${navigationSource}; navigateToFreshChat`, {
      CHATGPT_URL: "https://chatgpt.com/",
      manualRecoveryState: (code: string) =>
        code === "chatgpt_login_required" ? "login_required" : null,
      sendToTab: async () => ({ failureCode: "chatgpt_login_required" }),
      chrome: { tabs: { get: async () => ({ url: "https://chatgpt.com/" }), update, reload } },
    }) as (slot: { tabId: number }, active: boolean) => Promise<void>;
    await expect(navigateToFreshChat({ tabId: 1 }, false)).rejects.toThrow(
      "chatgpt_login_required",
    );
    expect(update).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
