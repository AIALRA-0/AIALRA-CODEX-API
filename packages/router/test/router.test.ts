import { describe, expect, it } from "vitest";

import { TaskContractSchema } from "@aialra/contracts";

import { selectRoute } from "../src/index.js";

describe("selectRoute", () => {
  it("routes bounded schema work to Luna", () => {
    const task = TaskContractSchema.parse({
      objective: "Classify the message",
      taskKind: "bounded",
      validation: { responseSchema: { type: "object" }, acceptanceTests: [] },
    });

    expect(selectRoute(task, null).model).toBe("gpt-5.6-luna");
  });

  it("keeps explicit model selection on Codex", () => {
    const task = TaskContractSchema.parse({
      objective: "Review the integration",
      model: "terra",
    });

    expect(selectRoute(task, null)).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-terra",
      sticky: true,
    });
  });

  it("keeps bounded work on Codex Luna under quota pressure", () => {
    const task = TaskContractSchema.parse({
      objective: "Summarize records",
      taskKind: "batch",
    });

    const decision = selectRoute(task, {
      provider: "codex",
      usedPercent: 90,
      windowDurationMinutes: 300,
      resetsAt: null,
      planType: "pro",
      fetchedAt: new Date().toISOString(),
      source: "app-server",
      windows: [],
      stale: false,
    });

    expect(decision.provider).toBe("codex");
    expect(decision.model).toBe("gpt-5.6-luna");
  });

  it("reserves constrained capacity from automatic Terra work", () => {
    const task = TaskContractSchema.parse({
      objective: "Review the integration",
      taskKind: "review",
    });

    expect(() =>
      selectRoute(task, {
        provider: "codex",
        usedPercent: 90,
        windowDurationMinutes: 300,
        resetsAt: null,
        planType: "pro",
        fetchedAt: new Date().toISOString(),
        source: "app-server",
        windows: [],
        stale: false,
      }),
    ).toThrow("codex_capacity_constrained");
  });

  it("routes an explicit ChatGPT web task without consulting Codex quota", () => {
    const task = TaskContractSchema.parse({
      objective: "Search a synthetic topic",
      executionChannel: "chatgpt_web",
      model: "chatgpt-web.auto",
      chatgptWeb: { mode: "search", temporaryChat: true, requireSources: true },
      deadlineMs: 600_000,
    });

    expect(selectRoute(task, null)).toMatchObject({
      provider: "chatgpt_web",
      model: "chatgpt-web.auto",
      reasonCode: "explicit_chatgpt_web_channel",
      sticky: true,
    });
  });
});
