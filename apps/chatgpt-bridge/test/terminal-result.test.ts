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
  terminalComposer = false,
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
    userMessageText: (node: typeof user) => node.text,
    userMessageMatchesObjective: (node: typeof user, objective: string) => node.text === objective,
    normalizedText: (value: string) => value.replace(/\s+/g, " ").trim(),
    boundTemporaryDocument: () => ownership,
    boundInvocationDocument: () => ownership,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    assistantTurnElements: () => [assistant],
    assistantTextChannels: () => ({
      extracted: changes && now >= 10_000 ? "later answer" : "exact answer",
    }),
    activeGenerationControl: () => (generating ? {} : null),
    SELECTORS: { stop: [] },
    hasTerminalCopyAction: () => copy,
    hasTerminalComposerState: () => terminalComposer,
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
    TERMINAL_COMPOSER_CONFIRM_MS: 30_000,
    TERMINAL_BLANK_CONFIRM_MS: 15_000,
    SELECTOR_DIAGNOSTIC_GRACE_MS: 5_000,
  };
  const waitForResult = runInNewContext(
    `${source.slice(source.indexOf("async function waitForStableResult("), source.indexOf("async function invoke("))}; waitForStableResult`,
    context,
  );
  return {
    run: (deadline = 31_000) =>
      waitForResult(0, 0, "objective", "EXPECTED_END", "document", deadline, "job"),
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
  it("accepts stable text after a longer terminal-composer fallback window", async () => {
    const h = harness({ copy: false, terminalComposer: true });
    expect(await h.run(32_000)).toEqual({ outputText: "exact answer" });
    expect(h.now()).toBeGreaterThanOrEqual(31_000);
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

describe("active generation control detection", () => {
  function detect({
    testId = null,
    label = "Stop generating",
    text = "",
    width = 20,
    height = 20,
    display = "block",
    visibility = "visible",
    opacity = "1",
    pointerEvents = "auto",
    checkVisibility = true,
  }: {
    testId?: string | null;
    label?: string;
    text?: string;
    width?: number;
    height?: number;
    display?: string;
    visibility?: string;
    opacity?: string;
    pointerEvents?: string;
    checkVisibility?: boolean;
  } = {}) {
    const element = {
      getBoundingClientRect: () => ({ width, height }),
      getAttribute: (name: string) =>
        name === "data-testid" ? testId : name === "aria-label" ? label : null,
      checkVisibility: () => checkVisibility,
    };
    const context = {
      document: {},
      SELECTORS: { stop: [] },
      all: () => [element],
      getComputedStyle: () => ({ display, visibility, opacity, pointerEvents }),
      normalizedText: (value: string) => value.replace(/\s+/g, " ").trim(),
      visibleText: () => text,
    };
    const activeGenerationControl = runInNewContext(
      `${source.slice(source.indexOf("function activeGenerationControl("), source.indexOf("function sendControlFor("))}; activeGenerationControl`,
      context,
    );
    return activeGenerationControl();
  }

  it("accepts a visible generation stop control", () => {
    expect(detect()).not.toBeNull();
    expect(detect({ testId: "stop-button", label: "" })).not.toBeNull();
  });

  it("ignores hidden stale stop controls", () => {
    expect(detect({ width: 0 })).toBeNull();
    expect(detect({ display: "none" })).toBeNull();
    expect(detect({ opacity: "0" })).toBeNull();
    expect(detect({ pointerEvents: "none" })).toBeNull();
    expect(detect({ checkVisibility: false })).toBeNull();
  });

  it("ignores voice and dictation stop controls", () => {
    expect(detect({ label: "Stop dictation" })).toBeNull();
    expect(detect({ label: "停止语音输入" })).toBeNull();
  });
});

it("extracts and deduplicates linked and plain-text public sources from the owned answer", () => {
  const anchors = [{ href: "https://example.test/source" }];
  const root = { querySelectorAll: () => anchors };
  const context = {
    assistantTextChannels: () => ({
      extracted:
        "Answer https://example.test/source and https://docs.example.test/guide). AIALRA_WEB_END_TEST",
    }),
    assistantTurnContainer: () => root,
  };
  const extractResult = runInNewContext(
    `${source.slice(source.indexOf("function withoutCompletionMarker("), source.indexOf("async function waitForUserEcho("))}; extractResult`,
    context,
  );
  expect(extractResult({}, "AIALRA_WEB_END_TEST")).toEqual({
    outputText: "Answer https://example.test/source and https://docs.example.test/guide).",
    sources: ["https://example.test/source", "https://docs.example.test/guide"],
  });
});

describe("strict structured answer extraction", () => {
  const marker = "AIALRA_WEB_END_0123456789ABCDEF";
  function extract(rawCode: string, remainder: string) {
    const code = { textContent: rawCode };
    const root = {
      querySelectorAll: (selector: string) => (selector === "pre code" ? [code] : []),
      cloneNode: () => ({ textContent: remainder, querySelectorAll: () => [] }),
    };
    const context = {
      assistantTurnContainer: () => root,
      normalizedText: (value: string) => value.replace(/\s+/g, " ").trim(),
    };
    return runInNewContext(
      `${source.slice(source.indexOf("function withoutCompletionMarker("), source.indexOf("function extractResult("))}; structuredCodeResult`,
      context,
    )({}, marker);
  }

  it("accepts one JSON code block when the completion marker is outside", () => {
    expect(extract('{"summary":"ok"}', `JSON ${marker}`)).toBe('{"summary":"ok"}');
  });

  it("accepts one JSON code block when the completion marker is inside", () => {
    expect(extract(`{"summary":"ok"}\n${marker}`, "JSON")).toBe('{"summary":"ok"}');
  });

  it("rejects extra prose, malformed JSON, and foreign task markers", () => {
    expect(extract('{"summary":"ok"}', `JSON explanation ${marker}`)).toBeNull();
    expect(extract(`{"summary":"broken\nvalue"}\n${marker}`, "JSON")).toBeNull();
    expect(extract('{"summary":"ok"}\nAIALRA_WEB_END_FEDCBA9876543210', "JSON")).toBeNull();
  });
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
