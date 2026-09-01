import "reflect-metadata";

import { describe, expect, it } from "vitest";

import { TaskContractSchema, type Job } from "@aialra/contracts";

import { chatCompletionFromJob, chatMessagesToPrompt } from "../src/chat/chat.controller.js";

describe("chatMessagesToPrompt", () => {
  it("renders a fresh conversation as a labeled transcript", () => {
    const prompt = chatMessagesToPrompt(
      [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Classify this" },
      ],
      false,
    );
    expect(prompt.objective).toContain("Be terse.");
    expect(prompt.objective).toContain("User: Hi");
    expect(prompt.objective).toContain("Assistant: Hello");
    expect(prompt.objective.trimEnd().endsWith("Assistant:")).toBe(true);
  });

  it("sends only the latest user turn when resuming a thread", () => {
    const prompt = chatMessagesToPrompt(
      [
        { role: "user", content: "First" },
        { role: "assistant", content: "Answer" },
        { role: "user", content: "Second" },
      ],
      true,
    );
    expect(prompt.objective).toBe("Second");
  });

  it("rejects a resume request without a user message", () => {
    expect(() =>
      chatMessagesToPrompt([{ role: "assistant", content: "orphan" }], true),
    ).toThrowError(/user message/);
  });
});

describe("chatCompletionFromJob", () => {
  function jobFixture(output: unknown): Job {
    const now = new Date().toISOString();
    return {
      id: "567bd245-865b-4d79-b978-589170a56171",
      status: "succeeded",
      requestHash: "hash",
      idempotencyKey: null,
      callerId: "caller-1",
      task: TaskContractSchema.parse({
        objective: "Say hi",
        sessionKey: "thread-1",
        sessionMode: "persistent",
      }),
      route: {
        provider: "codex",
        model: "gpt-5.6-luna",
        effort: "low",
        policyVersion: "1.0.0",
        reasonCode: "session_sticky",
        sticky: true,
      },
      output,
      errorCode: null,
      errorMessage: null,
      usage: {
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 30,
        codexCredits: 0.1,
        apiEquivalentUsd: 0.001,
        quotaUsedPercentBefore: null,
        quotaUsedPercentAfter: null,
        quotaWindowDeltaPercent: null,
        allocatedSubscriptionUsd: null,
      },
      validation: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now,
    };
  }

  it("maps a succeeded job to an OpenAI chat.completion", () => {
    const completion = chatCompletionFromJob(jobFixture("hello there"), 8_192);
    expect(completion.object).toBe("chat.completion");
    expect(completion.id).toBe("chatcmpl-567bd245-865b-4d79-b978-589170a56171");
    expect(completion.model).toBe("gpt-5.6-luna");
    expect(completion.choices[0].message).toEqual({ role: "assistant", content: "hello there" });
    expect(completion.choices[0].finish_reason).toBe("stop");
    expect(completion.usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
    });
    expect(completion.aialra).toEqual({
      job_id: "567bd245-865b-4d79-b978-589170a56171",
      session_key: "thread-1",
      measurement_status: "measured",
    });
  });

  it("does not publish synthetic token counts for a ChatGPT web result", () => {
    const job = jobFixture("browser result");
    job.task = TaskContractSchema.parse({
      objective: "Search",
      executionChannel: "chatgpt_web",
      model: "chatgpt-web.auto",
      chatgptWeb: { mode: "search", temporaryChat: true, requireSources: true },
      deadlineMs: 600_000,
    });
    job.route = {
      provider: "chatgpt_web",
      model: "chatgpt-web.auto",
      effort: "low",
      policyVersion: "1.0.0",
      reasonCode: "explicit_chatgpt_web_channel",
      sticky: true,
    };
    job.usage = { ...job.usage, measurementStatus: "unavailable" };

    const completion = chatCompletionFromJob(job, 8_192);
    expect(completion.usage).toBeUndefined();
    expect(completion.aialra?.measurement_status).toBe("unavailable");
  });

  it("serializes structured output and marks truncated answers as length", () => {
    const completion = chatCompletionFromJob(jobFixture({ category: "notice" }), 30);
    expect(completion.choices[0].message.content).toBe('{"category":"notice"}');
    expect(completion.choices[0].finish_reason).toBe("length");
  });
});
