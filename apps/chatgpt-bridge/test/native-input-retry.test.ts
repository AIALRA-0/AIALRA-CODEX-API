import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { ExtensionNativeInputRequestSchema } from "../src/protocol.js";

const source = readFileSync(new URL("../extension/content-script.js", import.meta.url), "utf8");
const guardSource = source.slice(
  source.indexOf("function canRetryEmptyNativeInput("),
  source.indexOf("async function reportProgress("),
);

function retryAllowed({
  userCount = 0,
  composerText = "",
  generating = false,
  sameDocument = true,
} = {}) {
  const guard = runInNewContext(`${guardSource}; canRetryEmptyNativeInput`, {
    SELECTORS: { composer: "composer", stop: "stop" },
    first: (selector: string) =>
      selector === "composer" ? { text: composerText } : generating ? {} : null,
    userMessages: () => Array.from({ length: userCount }),
    canonicalEditorText: (text: string) => text,
    composerPlainText: (composer: { text: string }) => composer.text,
    boundInvocationDocument: () => sameDocument,
  }) as (beforeUserCount: number, invocation: object) => boolean;
  return guard(0, { documentToken: "synthetic", temporaryChat: true });
}

describe("native input retry boundary", () => {
  it("allows one more paste only on the same empty, unsent document", () => {
    expect(retryAllowed()).toBe(true);
    expect(retryAllowed({ userCount: 1 })).toBe(false);
    expect(retryAllowed({ composerText: "partial input" })).toBe(false);
    expect(retryAllowed({ generating: true })).toBe(false);
    expect(retryAllowed({ sameDocument: false })).toBe(false);
  });

  it("uses a distinct bridge action for the guarded second paste", async () => {
    const inputSource = source.slice(
      source.indexOf("async function nativeSetComposerText("),
      source.indexOf("function canRetryEmptyNativeInput("),
    );
    const composer = { text: "synthetic" };
    const send = vi.fn(async (message: { action: string }) => ({ ok: Boolean(message.action) }));
    let now = 0;
    const input = runInNewContext(`${inputSource}; nativeSetComposerText`, {
      nativePoint: () => ({ x: 100, y: 200 }),
      sendRuntimeMessage: send,
      Date: { now: () => (now += 500) },
      first: () => composer,
      SELECTORS: { composer: "composer" },
      canonicalEditorText: (text: string) => text,
      composerPlainText: (editor: { text: string }) => editor.text,
      waitForMutation: async () => {},
      setTimeout: (callback: () => void) => callback(),
    }) as (
      composer: object,
      text: string,
      jobId: string,
      deadline: number,
      attempt: number,
    ) => Promise<void>;
    const jobId = "0190abcd-0000-7000-8000-000000000001";
    await input(composer, "synthetic", jobId, 100_000, 2);
    expect(send.mock.calls.map(([message]) => message.action)).toEqual([
      "paste_prompt_retry",
      "clear_clipboard",
    ]);
    expect(
      ExtensionNativeInputRequestSchema.parse({
        type: "native_input_request",
        jobId,
        action: send.mock.calls[0]?.[0].action,
        x: 100,
        y: 200,
        text: "synthetic",
      }).action,
    ).toBe("paste_prompt_retry");
  });
});
