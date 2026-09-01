import { describe, expect, it } from "vitest";

import {
  ChatCompletionsRequestSchema,
  ExecutionPolicySchema,
  permissionProfileForPreset,
  ReasoningEffortSchema,
  ResponsesRequestSchema,
  sessionThreadTtlMs,
  TaskContractSchema,
  ChatGptWebQualificationItemSchema,
  ChatGptWebQualificationSuiteSchema,
} from "../src/index.js";

describe("ReasoningEffortSchema", () => {
  it("accepts max reasoning effort", () => {
    expect(ReasoningEffortSchema.parse("max")).toBe("max");
  });

  it("accepts structured validation checks", () => {
    const task = TaskContractSchema.parse({
      objective: "Return a marker",
      validation: { checks: [{ type: "equals", expected: "OK" }] },
    });
    expect(task.validation.checks).toEqual([{ type: "equals", expected: "OK", trim: true }]);
  });
});

describe("ChatGPT web qualification contract", () => {
  it("accepts the single probe suite and defaults its verification field", () => {
    expect(ChatGptWebQualificationSuiteSchema.parse("single_probe")).toBe("single_probe");
    expect(
      ChatGptWebQualificationItemSchema.parse({
        index: 1,
        name: "chat-1",
        mode: "chat",
        status: "pending",
        durationMs: null,
        outputLength: null,
        outputSha256: null,
        sourceCount: null,
        errorCode: null,
        submittedCount: 0,
        ownershipMatched: null,
      }).temporaryChatVerified,
    ).toBe(false);
  });
});

describe("permission policies", () => {
  it("requires the default preset to be allowed", () => {
    expect(() =>
      ExecutionPolicySchema.parse({ defaultPreset: "full", allowedPresets: ["restricted"] }),
    ).toThrow();
  });

  it("maps full access to an isolated writable workspace without provider approval", () => {
    expect(permissionProfileForPreset("full")).toEqual({
      preset: "full",
      filesystem: "write",
      network: "all",
      allowedHosts: [],
      requireApprovalForWrites: false,
      requireApprovalForExternalActions: false,
    });
  });
});

describe("TaskContractSchema", () => {
  it("applies secure defaults", () => {
    const task = TaskContractSchema.parse({ objective: "Classify this message" });

    expect(task.permissions.filesystem).toBe("read");
    expect(task.permissions.network).toBe("none");
    expect(task.model).toBe("auto");
    expect(task.deadlineMs).toBe(120_000);
  });

  it("rejects unbounded deadlines", () => {
    expect(() =>
      TaskContractSchema.parse({ objective: "Run forever", deadlineMs: 3_600_001 }),
    ).toThrow();
  });

  it("accepts max reasoning effort", () => {
    const task = TaskContractSchema.parse({ objective: "Reason deeply", effort: "max" });

    expect(task.effort).toBe("max");
  });

  it("accepts the namespaced permission extension", () => {
    const request = ResponsesRequestSchema.parse({
      input: "Search the public web",
      aialra: { permission_preset: "full" },
    });
    expect(request.aialra?.permission_preset).toBe("full");
  });

  it("accepts an ephemeral ChatGPT web task and keeps it explicit", () => {
    const task = TaskContractSchema.parse({
      objective: "Research a synthetic topic",
      executionChannel: "chatgpt_web",
      model: "chatgpt-web.auto",
      sessionMode: "ephemeral",
      chatgptWeb: { mode: "search", temporaryChat: true, requireSources: true },
      deadlineMs: 600_000,
    });

    expect(task.executionChannel).toBe("chatgpt_web");
    expect(task.chatgptWeb?.mode).toBe("search");
    expect(task.chatgptWeb).toMatchObject({
      conversationMode: "temporary_per_request",
      temporaryChat: true,
      personalized: false,
    });
  });

  it("rejects a persistent ChatGPT web task or a missing web contract", () => {
    expect(
      TaskContractSchema.safeParse({
        objective: "Do not retain this browser conversation",
        executionChannel: "chatgpt_web",
        model: "chatgpt-web.auto",
        sessionMode: "persistent",
        chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
      }).success,
    ).toBe(false);
    expect(
      TaskContractSchema.safeParse({
        objective: "Missing web options",
        executionChannel: "chatgpt_web",
        model: "chatgpt-web.auto",
      }).success,
    ).toBe(false);
  });

  it("requires a non-personalized Temporary Chat for every web mode", () => {
    expect(
      TaskContractSchema.safeParse({
        objective: "Search a synthetic topic",
        executionChannel: "chatgpt_web",
        model: "chatgpt-web.auto",
        sessionMode: "ephemeral",
        chatgptWeb: { mode: "search", temporaryChat: true, requireSources: true },
      }).success,
    ).toBe(true);
    expect(
      TaskContractSchema.safeParse({
        objective: "Research a synthetic topic",
        executionChannel: "chatgpt_web",
        model: "chatgpt-web.auto",
        sessionMode: "ephemeral",
        chatgptWeb: { mode: "deep_research", temporaryChat: true, requireSources: true },
      }).success,
    ).toBe(true);
    expect(
      TaskContractSchema.safeParse({
        objective: "Research a synthetic topic",
        executionChannel: "chatgpt_web",
        model: "chatgpt-web.auto",
        sessionMode: "ephemeral",
        chatgptWeb: { mode: "deep_research", temporaryChat: false, requireSources: true },
      }).success,
    ).toBe(false);
  });
});

describe("ResponsesRequestSchema", () => {
  it("accepts max reasoning effort", () => {
    const request = ResponsesRequestSchema.parse({
      input: "Reason deeply",
      reasoning: { effort: "max" },
    });

    expect(request.reasoning?.effort).toBe("max");
  });
});

describe("session modes and chat completions contract", () => {
  it("defaults every task to an ephemeral session", () => {
    const task = TaskContractSchema.parse({ objective: "One shot classification" });
    expect(task.sessionMode).toBe("ephemeral");
    expect(task.sessionKey).toBeUndefined();
  });

  it("accepts persistent sessions and a resume key", () => {
    const task = TaskContractSchema.parse({
      objective: "Continue the conversation",
      sessionKey: "0190abcd-0000-7000-8000-000000000000",
      sessionMode: "persistent",
    });
    expect(task.sessionMode).toBe("persistent");
    expect(task.sessionKey).toBe("0190abcd-0000-7000-8000-000000000000");
  });

  it("exposes session fields through the Responses aialra namespace", () => {
    const request = ResponsesRequestSchema.parse({
      input: "Continue",
      aialra: { session_key: "thread-1", session_mode: "persistent", deadline_ms: 5_000 },
    });
    expect(request.aialra?.session_key).toBe("thread-1");
    expect(request.aialra?.session_mode).toBe("persistent");
    expect(request.aialra?.deadline_ms).toBe(5_000);
  });

  it("accepts a minimal Chat Completions request", () => {
    const request = ChatCompletionsRequestSchema.parse({
      model: "luna",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(request.stream).toBe(false);
    expect(request.model).toBe("luna");
  });

  it("rejects unsupported Chat Completions parameters", () => {
    const parsed = ChatCompletionsRequestSchema.safeParse({
      model: "auto",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("requires at least one message", () => {
    expect(ChatCompletionsRequestSchema.safeParse({ model: "auto", messages: [] }).success).toBe(
      false,
    );
  });

  it("uses a 24 hour default thread lifetime", () => {
    expect(sessionThreadTtlMs()).toBe(86_400_000);
  });
});
