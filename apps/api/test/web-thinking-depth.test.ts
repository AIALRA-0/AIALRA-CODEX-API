import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";

import { TaskContractSchema, type Job, type JobEvent } from "@aialra/contracts";

import { ChatCompletionsController } from "../src/chat/chat.controller.js";
import { JobsController } from "../src/jobs/jobs.controller.js";
import { summarizeWebExecution } from "../src/jobs/web-execution.js";
import { ResponsesController } from "../src/responses/responses.controller.js";

const jobId = "00000000-0000-4000-8000-000000000001";
const now = new Date().toISOString();

function webJob(thinkingDepth?: string): Job {
  return {
    id: jobId,
    status: "succeeded",
    requestHash: "hash",
    idempotencyKey: "key",
    callerId: "caller",
    task: TaskContractSchema.parse({
      objective: "Synthetic review",
      model: "chatgpt-web.auto",
      executionChannel: "chatgpt_web",
      chatgptWeb: { mode: "chat", thinkingDepth },
    }),
    route: {
      provider: "chatgpt_web",
      model: "chatgpt-web.auto",
      effort: "medium",
      policyVersion: "1.0.0",
      reasonCode: "explicit_chatgpt_web_channel",
      sticky: true,
    },
    output: null,
    errorCode: null,
    errorMessage: null,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      codexCredits: null,
      apiEquivalentUsd: null,
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

function toolEvent(sequence: number, data: Record<string, unknown>): JobEvent {
  return { id: String(sequence), jobId, sequence, type: "tool", data, createdAt: now };
}

describe("web thinking depth API", () => {
  it("still passes a standard reasoning effort to the Codex channel", async () => {
    const create = vi.fn().mockRejectedValue(new Error("stop-before-upstream"));
    const controller = new ChatCompletionsController({ create } as never);
    await expect(
      controller.create(
        {
          model: "auto",
          messages: [{ role: "user", content: "Synthetic request" }],
          reasoning_effort: "high",
        },
        { header: () => "synthetic-key" } as never,
        {} as never,
      ),
    ).rejects.toThrow("stop-before-upstream");
    expect(create.mock.calls[0]?.[0].task).toMatchObject({
      executionChannel: "codex",
      effort: "high",
    });
  });

  it("rejects a standard Chat Completions effort before creating a web job", async () => {
    const create = vi.fn();
    const controller = new ChatCompletionsController({ create } as never);
    await expect(
      controller.create(
        {
          model: "chatgpt-web.auto",
          messages: [{ role: "user", content: "Synthetic request" }],
          reasoning_effort: "high",
        },
        {} as never,
        {} as never,
      ),
    ).rejects.toMatchObject({ response: { error: { code: "unsupported_parameter" } } });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a standard Responses effort even when the web depth is also present", async () => {
    const create = vi.fn();
    const controller = new ResponsesController({ create } as never);
    await expect(
      controller.create(
        {
          model: "chatgpt-web.auto",
          input: "Synthetic request",
          reasoning: { effort: "high" },
          aialra: { thinking_depth: "Medium" },
        },
        { header: () => "key" } as never,
        {} as never,
      ),
    ).rejects.toMatchObject({ response: { error: { code: "unsupported_parameter" } } });
    expect(create).not.toHaveBeenCalled();
  });

  it("reads the page-confirmed default rather than the legacy route effort", () => {
    const job = webJob();
    const summary = summarizeWebExecution(job, [
      toolEvent(1, { kind: "chatgpt_web_account_assigned", accountId: "account-a" }),
      toolEvent(2, {
        kind: "chatgpt_web",
        phase: "mode_selected",
        accountId: "account-a",
        diagnosticSummary: { resolvedThinkingDepth: "Medium" },
      }),
    ]);
    expect(summary).toEqual({
      accountId: "account-a",
      requestedThinkingDepth: null,
      resolvedThinkingDepth: "Medium",
      thinkingDepthVerified: true,
    });
    expect(job.route?.effort).toBe("medium");
  });

  it("does not reuse a prior account's observation after a pre-submit switch", () => {
    const summary = summarizeWebExecution(webJob("Heavy"), [
      toolEvent(1, { kind: "chatgpt_web_account_assigned", accountId: "account-a" }),
      toolEvent(2, {
        kind: "chatgpt_web",
        phase: "mode_selected",
        accountId: "account-a",
        diagnosticSummary: { resolvedThinkingDepth: "Heavy" },
      }),
      toolEvent(3, { kind: "chatgpt_web_account_assigned", accountId: "account-b" }),
    ]);
    expect(summary).toEqual({
      accountId: "account-b",
      requestedThinkingDepth: "Heavy",
      resolvedThinkingDepth: null,
      thinkingDepthVerified: false,
    });
  });

  it("does not call a mismatched page label verified", () => {
    const summary = summarizeWebExecution(webJob("Heavy"), [
      toolEvent(1, { kind: "chatgpt_web_account_assigned", accountId: "account-a" }),
      toolEvent(2, {
        kind: "chatgpt_web",
        phase: "mode_selected",
        accountId: "account-a",
        diagnosticSummary: { resolvedThinkingDepth: "Medium" },
      }),
    ]);
    expect(summary.resolvedThinkingDepth).toBe("Medium");
    expect(summary.thinkingDepthVerified).toBe(false);
  });

  it("can recover a verified label from a later submitted event", () => {
    const summary = summarizeWebExecution(webJob(), [
      toolEvent(1, { kind: "chatgpt_web_account_assigned", accountId: "account-a" }),
      toolEvent(2, { kind: "chatgpt_web", phase: "mode_selected", accountId: "account-a" }),
      toolEvent(3, {
        kind: "chatgpt_web",
        phase: "submitted",
        accountId: "account-a",
        diagnosticSummary: { resolvedThinkingDepth: "Medium" },
      }),
    ]);
    expect(summary).toMatchObject({
      accountId: "account-a",
      resolvedThinkingDepth: "Medium",
      thinkingDepthVerified: true,
    });
  });

  it("adds the evidence summary only to web job detail", async () => {
    const job = webJob("Heavy");
    const events = [
      toolEvent(1, { kind: "chatgpt_web_account_assigned", accountId: "account-b" }),
      toolEvent(2, {
        kind: "chatgpt_web",
        phase: "mode_selected",
        accountId: "account-b",
        diagnosticSummary: { resolvedThinkingDepth: "Heavy" },
      }),
    ];
    const getForActor = vi.fn().mockResolvedValue(job);
    const eventsForActor = vi.fn().mockResolvedValue(events);
    const controller = new JobsController({ getForActor, eventsForActor } as never);
    const result = await controller.get(jobId, { callerId: "caller" } as never);
    expect(result.webExecution?.resolvedThinkingDepth).toBe("Heavy");
    expect(eventsForActor).toHaveBeenCalledWith(jobId, "caller", false);
  });
});
