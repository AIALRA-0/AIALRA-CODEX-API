import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { TaskContractSchema, type Job } from "@aialra/contracts";
import { InMemoryJobRepository } from "@aialra/persistence";
import type { ModelProvider } from "@aialra/providers";

import { attachQuotaWindowDelta, validateOutput, WorkerService } from "../src/worker.service.js";

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    status: "queued",
    requestHash: "request-hash",
    idempotencyKey: "idempotency-key",
    callerId: "test",
    task: TaskContractSchema.parse({
      objective: "Return a category",
      taskKind: "bounded",
      validation: {
        responseSchema: {
          type: "object",
          properties: { category: { type: "string" } },
          required: ["category"],
          additionalProperties: false,
        },
        acceptanceTests: [],
      },
    }),
    route: null,
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
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

describe("validation", () => {
  it("moves invalid structured output to review", () => {
    const result = validateOutput(makeJob(), { unexpected: true });
    expect(result.passed).toBe(false);
    expect(result.schemaPassed).toBe(false);
  });
});

describe("WorkerService", () => {
  it("runs one sticky provider and persists successful output", async () => {
    const repository = new InMemoryJobRepository();
    const job = makeJob();
    await repository.create(job);
    const provider: ModelProvider = {
      name: "codex",
      invoke: vi.fn(async ({ onEvent }) => {
        await onEvent?.({ type: "output.delta", data: { delta: "done" } });
        return {
          output: { category: "notification" },
          outputText: '{"category":"notification"}',
          threadId: "thread-test",
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            outputTokens: 10,
            codexCredits: 0.001,
            apiEquivalentUsd: 0.00004,
            quotaUsedPercentBefore: null,
            quotaUsedPercentAfter: null,
            quotaWindowDeltaPercent: null,
            allocatedSubscriptionUsd: null,
          },
        };
      }),
    };
    const worker = new WorkerService({
      repository,
      provider,
      quotaClient: {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            provider: "codex",
            usedPercent: 10,
            windowDurationMinutes: 300,
            resetsAt: "2026-08-27T20:00:00.000Z",
            planType: "pro",
            fetchedAt: new Date().toISOString(),
            source: "app-server",
            windows: [],
            stale: false,
          })
          .mockResolvedValueOnce({
            provider: "codex",
            usedPercent: 10.125,
            windowDurationMinutes: 300,
            resetsAt: "2026-08-27T20:00:00.000Z",
            planType: "pro",
            fetchedAt: new Date().toISOString(),
            source: "app-server",
            windows: [],
            stale: false,
          }),
      },
      createWorkspace: async () => "test-workspace",
      removeWorkspace: async () => undefined,
    });

    await worker.processJob(job.id);

    const completed = await repository.findById(job.id);
    expect(provider.invoke).toHaveBeenCalledOnce();
    expect(completed?.status).toBe("succeeded");
    expect(completed?.task.sessionKey).toBe("thread-test");
    expect(completed?.usage.codexCredits).toBe(0.001);
    expect(completed?.usage.quotaWindowDeltaPercent).toBe(0.125);
  });

  it("does not claim a quota delta across different windows", () => {
    const usage = makeJob().usage;
    const before = {
      provider: "codex" as const,
      usedPercent: 99,
      windowDurationMinutes: 300,
      resetsAt: "2026-08-27T20:00:00.000Z",
      planType: "pro",
      fetchedAt: "2026-08-27T19:59:00.000Z",
      source: "app-server" as const,
      windows: [],
      stale: false,
    };
    const after = {
      ...before,
      usedPercent: 1,
      resetsAt: "2026-08-28T01:00:00.000Z",
      fetchedAt: "2026-08-27T20:01:00.000Z",
    };

    expect(attachQuotaWindowDelta(usage, before, after).quotaWindowDeltaPercent).toBeNull();
  });

  it("does not retry a non-transient provider error", async () => {
    const repository = new InMemoryJobRepository();
    const job = makeJob();
    await repository.create(job);
    const provider: ModelProvider = {
      name: "codex",
      invoke: vi.fn(async () => {
        throw new Error("schema rejected");
      }),
    };
    const worker = new WorkerService({
      repository,
      provider,
      quotaClient: { read: async () => Promise.reject(new Error("offline")) },
      createWorkspace: async () => "test-workspace",
      removeWorkspace: async () => undefined,
    });

    await worker.processJob(job.id);

    expect(provider.invoke).toHaveBeenCalledOnce();
    expect((await repository.findById(job.id))?.status).toBe("failed");
  });

  it("rejects secret-bearing output before it is stored", async () => {
    const repository = new InMemoryJobRepository();
    const job = makeJob();
    await repository.create(job);
    const provider: ModelProvider = {
      name: "codex",
      workspaceMode: "provider",
      invoke: vi.fn(async () => ({
        output: "read /codex-auth/auth.json",
        outputText: "read /codex-auth/auth.json",
        threadId: null,
        usage: makeJob().usage,
      })),
    };
    const worker = new WorkerService({
      repository,
      provider,
      quotaClient: { read: async () => Promise.reject(new Error("offline")) },
    });

    await worker.processJob(job.id);

    const completed = await repository.findById(job.id);
    expect(completed?.status).toBe("failed");
    expect(completed?.output).toBeNull();
    expect(completed?.errorMessage).not.toContain("/codex-auth");
  });
});
