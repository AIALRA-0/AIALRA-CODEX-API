import { describe, expect, it } from "vitest";

import {
  fixedBridgeError,
  isStableOutput,
  modelIdForLabel,
  normalizeModels,
  sanitizeSourceUrls,
} from "../src/core.js";
import { ExtensionMessageSchema, ExtensionNativeClickRequestSchema } from "../src/protocol.js";

describe("ChatGPT web bridge core", () => {
  it("creates stable model ids without exposing page selectors", () => {
    expect(modelIdForLabel("GPT-5 Pro")).toMatch(/^chatgpt-web\.gpt-5-pro\.[a-f0-9]{8}$/);
    expect(modelIdForLabel("GPT-5 Pro")).toBe(modelIdForLabel("GPT-5 Pro"));
  });

  it("always exposes the automatic web model once", () => {
    const models = normalizeModels([
      { id: "", displayName: "GPT-5 Pro", available: true },
      { id: "", displayName: "GPT-5 Pro", available: true },
    ]);
    expect(models.filter((model) => model.id === "chatgpt-web.auto")).toHaveLength(1);
    expect(models).toHaveLength(2);
  });

  it("returns only public http sources and removes duplicates", () => {
    expect(
      sanitizeSourceUrls([
        "https://example.com/report#section",
        "https://example.com/report",
        "https://chatgpt.com/c/secret",
        "javascript:alert(1)",
      ]),
    ).toEqual(["https://example.com/report"]);
  });

  it("requires repeated non-empty output before declaring stability", () => {
    expect(isStableOutput(["partial", "final", "final"])).toBe(true);
    expect(isStableOutput(["partial", "final"])).toBe(false);
    expect(isStableOutput(["", ""])).toBe(false);
    expect(isStableOutput(["", "", ""])).toBe(false);
  });

  it("does not expose internal exception text in public errors", () => {
    expect(fixedBridgeError("chatgpt_ui_changed")).not.toContain("selector");
    expect(fixedBridgeError("database_password=synthetic-secret")).not.toContain(
      "synthetic-secret",
    );
  });

  it("limits native input to one point inside the isolated browser screen", () => {
    expect(
      ExtensionNativeClickRequestSchema.safeParse({
        type: "native_click_request",
        jobId: "0190abcd-0000-7000-8000-000000000001",
        action: "send_prompt",
        x: 1_439,
        y: 899,
      }).success,
    ).toBe(true);
    expect(
      ExtensionNativeClickRequestSchema.safeParse({
        type: "native_click_request",
        jobId: "0190abcd-0000-7000-8000-000000000001",
        action: "send_prompt",
        x: 1_440,
        y: 900,
      }).success,
    ).toBe(false);
  });

  it("reports a visible page rate limit without losing the signed-in state", () => {
    expect(
      ExtensionMessageSchema.safeParse({
        type: "models",
        pageReady: true,
        authenticated: false,
        models: [],
        activeTabs: 0,
        diagnostics: null,
        failureCode: "chatgpt_rate_limited",
      }).success,
    ).toBe(true);
  });
});
