import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../extension/content-script.js", import.meta.url), "utf8");
function harness({
  copy = true,
  generating = false,
  ownership = true,
  foreign = false,
  changes = false,
} = {}) {
  let now = 1_000;
  const user = { text: "objective", compareDocumentPosition: () => 4 };
  const assistant = {};
  const context = {
    Date: { now: () => now },
    cancelled: false,
    failureState: () => null,
    userMessages: () => [user],
    visibleText: (node: typeof user) => node.text,
    normalizedText: (value: string) => value.replace(/\s+/g, " ").trim(),
    boundTemporaryDocument: () => ownership,
    boundInvocationDocument: () => ownership,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    assistantTurnElements: () => [assistant],
    assistantTextChannels: () => ({
      extracted: changes && now >= 10_000 ? "later answer" : "exact answer",
    }),
    first: () => (generating ? {} : null),
    SELECTORS: { stop: [] },
    hasTerminalCopyAction: () => copy,
    hasForeignCompletionMarker: () => foreign,
    terminalActionsFor: () => [],
    visibleErrorKind: () => "other",
    extractResult: () => ({ outputText: changes ? "later answer" : "exact answer" }),
    assistantElementDiagnostics: () => null,
    reportProgress: async () => {},
    controlDiagnostics: () => ({}),
    waitForMutation: async () => {
      now += 750;
    },
    TERMINAL_RESULT_CONFIRM_MS: 15_000,
    TERMINAL_BLANK_CONFIRM_MS: 15_000,
    SELECTOR_DIAGNOSTIC_GRACE_MS: 5_000,
  };
  const waitForResult = runInNewContext(
    `${source.slice(source.indexOf("async function waitForStableResult("), source.indexOf("async function invoke("))}; waitForStableResult`,
    context,
  );
  return {
    run: () => waitForResult(0, 0, "objective", "EXPECTED_END", "document", 31_000, "job"),
    now: () => now,
  };
}

describe("validated visible completion", () => {
  it("accepts an exact answer without an extra sentinel only after stable terminal evidence", async () => {
    const h = harness();
    expect(await h.run()).toEqual({ outputText: "exact answer" });
    expect(h.now()).toBeGreaterThanOrEqual(16_000);
  });
  it("does not treat nonempty text without terminal controls as complete", async () => {
    await expect(harness({ copy: false }).run()).rejects.toThrow("chatgpt_output_incomplete");
  });
  it("does not finish while generation is active", async () => {
    await expect(harness({ generating: true }).run()).rejects.toThrow("chatgpt_output_incomplete");
  });
  it("restarts the stability window when the answer changes", async () => {
    const h = harness({ changes: true });
    expect(await h.run()).toEqual({ outputText: "later answer" });
    expect(h.now()).toBeGreaterThanOrEqual(25_000);
  });
  it.each([{ ownership: false }, { foreign: true }])(
    "rejects incorrect result ownership %j",
    async (options) => {
      await expect(harness(options).run()).rejects.toThrow("chatgpt_delivery_uncertain");
    },
  );
});

it("binds persistent Deep Research to the same fresh non-temporary document", () => {
  let currentToken = "document";
  let temporary = false;
  let supported = true;
  const context = {
    DOCUMENT_TOKEN: currentToken,
    boundTemporaryDocument: () => false,
    taskPageIsSupported: () => supported,
    temporaryChatEnabled: () => temporary,
  };
  const bound = runInNewContext(
    `${source.slice(source.indexOf("function boundInvocationDocument("), source.indexOf("function currentSurface("))}; boundInvocationDocument`,
    context,
  );

  expect(bound("document", false)).toBe(true);
  temporary = true;
  expect(bound("document", false)).toBe(false);
  temporary = false;
  supported = false;
  expect(bound("document", false)).toBe(false);
  supported = true;
  currentToken = "other";
  context.DOCUMENT_TOKEN = currentToken;
  expect(bound("document", false)).toBe(false);
});

it("retains the verified non-personalized fact only for the active verified document", () => {
  let observed: boolean | null = null;
  let temporary = true;
  const context = {
    activeJobId: null as string | null,
    verifiedNonPersonalizedDocumentToken: null as string | null,
    DOCUMENT_TOKEN: "document",
    temporaryChatPersonalized: () => observed,
    temporaryChatEnabled: () => temporary,
  };
  const read = runInNewContext(
    `${source.slice(source.indexOf("function diagnosticPersonalization("), source.indexOf("function controlDiagnostics("))}; diagnosticPersonalization`,
    context,
  );
  expect(read()).toBeNull();
  context.activeJobId = "job";
  context.verifiedNonPersonalizedDocumentToken = "document";
  expect(read()).toBe(false);
  observed = true;
  expect(read()).toBe(true);
  observed = null;
  temporary = false;
  expect(read()).toBeNull();
  temporary = true;
  context.DOCUMENT_TOKEN = "different";
  expect(read()).toBeNull();
  context.DOCUMENT_TOKEN = "document";
  context.activeJobId = null;
  expect(read()).toBeNull();
});
