import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { TaskContractSchema, type ChatGptWebStatus, type Job } from "@aialra/contracts";
import { defaultChatGptWebStatus, InMemoryJobRepository } from "@aialra/persistence";
import type { ModelProvider } from "@aialra/providers";

import {
  attachQuotaWindowDelta,
  isSafeChatGptWebRetry,
  nextChatGptWebStatus,
  validateOutput,
  WorkerService,
} from "../src/worker.service.js";

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
  it("marks invalid structured output as failed validation", () => {
    const result = validateOutput(makeJob(), { unexpected: true });
    expect(result.passed).toBe(false);
    expect(result.schemaPassed).toBe(false);
  });

  it("supports exact output checks with optional trimming", () => {
    const job = makeJob({
      task: TaskContractSchema.parse({
        objective: "Return the marker",
        validation: {
          checks: [{ type: "equals", expected: "ROUTER_E2E_OK", trim: true }],
        },
      }),
    });
    expect(validateOutput(job, "  ROUTER_E2E_OK\n").passed).toBe(true);
    const failed = validateOutput(job, "ROUTER_E2E_BAD");
    expect(failed.passed).toBe(false);
    expect(failed.messages[0]).toContain('expected="ROUTER_E2E_OK"');
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

  it("stores output and fails the call when a declared rule does not pass", async () => {
    const repository = new InMemoryJobRepository();
    const job = makeJob();
    await repository.create(job);
    const provider: ModelProvider = {
      name: "codex",
      workspaceMode: "provider",
      invoke: vi.fn(async () => ({
        output: { unexpected: true },
        outputText: '{"unexpected":true}',
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
    expect(completed?.errorCode).toBe("validation_failed");
    expect(completed?.output).toEqual({ unexpected: true });
  });

  it("succeeds when a normal text call has no validation rules", async () => {
    const repository = new InMemoryJobRepository();
    const job = makeJob({
      task: TaskContractSchema.parse({ objective: "Return a useful answer" }),
    });
    await repository.create(job);
    const provider: ModelProvider = {
      name: "codex",
      workspaceMode: "provider",
      invoke: vi.fn(async () => ({
        output: "done",
        outputText: "done",
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

    expect((await repository.findById(job.id))?.status).toBe("succeeded");
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

  it("uses the ChatGPT web provider once and preserves unavailable measurement status", async () => {
    const repository = new InMemoryJobRepository();
    const job = makeJob({
      task: TaskContractSchema.parse({
        objective: "Search a synthetic topic",
        executionChannel: "chatgpt_web",
        model: "chatgpt-web.auto",
        chatgptWeb: { mode: "search", temporaryChat: true, requireSources: true },
        deadlineMs: 600_000,
      }),
    });
    await repository.create(job);
    await repository.saveChatGptWebStatus({
      ...defaultChatGptWebStatus(),
      configuredEnabled: true,
      effectiveConcurrency: 1,
      circuitState: "closed",
      circuitReason: null,
      lastQualificationPassed: true,
    });
    await repository.setModelEnabled("chatgpt-web.auto", true, "test");
    const codexProvider: ModelProvider = {
      name: "codex",
      invoke: vi.fn(async () => {
        throw new Error("Codex must not receive this task");
      }),
    };
    const chatgptProvider: ModelProvider = {
      name: "chatgpt_web",
      workspaceMode: "provider",
      invoke: vi.fn(async () => ({
        output: "Synthetic answer",
        outputText: "Synthetic answer",
        threadId: null,
        sources: ["https://example.com/source"],
        usage: {
          ...makeJob().usage,
          measurementStatus: "unavailable" as const,
          subscriptionChannel: "chatgpt_pro_web" as const,
          sourceCount: 1,
          durationMs: 250,
        },
      })),
    };
    const worker = new WorkerService({
      repository,
      provider: codexProvider,
      chatgptProvider,
      quotaClient: { read: async () => Promise.reject(new Error("offline")) },
    });

    await worker.processJob(job.id);

    const completed = await repository.findById(job.id);
    expect(codexProvider.invoke).not.toHaveBeenCalled();
    expect(chatgptProvider.invoke).toHaveBeenCalledOnce();
    expect(completed?.status).toBe("succeeded");
    expect(completed?.usage.measurementStatus).toBe("unavailable");
    expect(completed?.usage.sourceCount).toBe(1);
  });

  it("does not resend a web task after a blank response", async () => {
    const repository = new InMemoryJobRepository();
    const job = makeJob({
      task: TaskContractSchema.parse({
        objective: "Return a synthetic marker",
        executionChannel: "chatgpt_web",
        model: "chatgpt-web.auto",
        chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
        deadlineMs: 600_000,
        budget: { maxOutputTokens: 8_192, maxAttempts: 2 },
      }),
    });
    await repository.create(job);
    await repository.saveChatGptWebStatus({
      ...defaultChatGptWebStatus(),
      configuredEnabled: true,
      effectiveConcurrency: 1,
      circuitState: "closed",
      circuitReason: null,
      lastQualificationPassed: true,
    });
    await repository.setModelEnabled("chatgpt-web.auto", true, "test");
    const webInvoke = vi
      .fn<ModelProvider["invoke"]>()
      .mockRejectedValueOnce(new Error("chatgpt_page_generation_blank:blank"))
      .mockResolvedValueOnce({
        output: "SYNTHETIC_OK",
        outputText: "SYNTHETIC_OK",
        threadId: null,
        usage: {
          ...makeJob().usage,
          measurementStatus: "unavailable",
          subscriptionChannel: "chatgpt_pro_web",
          durationMs: 500,
        },
      });
    const worker = new WorkerService({
      repository,
      provider: { name: "codex", invoke: vi.fn() },
      chatgptProvider: { name: "chatgpt_web", workspaceMode: "provider", invoke: webInvoke },
      quotaClient: { read: async () => Promise.reject(new Error("offline")) },
    });

    await worker.processJob(job.id);

    const completed = await repository.findById(job.id);
    expect(webInvoke).toHaveBeenCalledOnce();
    expect(completed?.status).toBe("failed");
    expect(completed?.errorCode).toBe("chatgpt_page_generation_blank");
  });

  it("keeps the web channel at one page after repeated success", () => {
    let status: ChatGptWebStatus = {
      ...defaultChatGptWebStatus(),
      configuredEnabled: true,
      effectiveConcurrency: 1,
      circuitState: "closed" as const,
      circuitReason: null,
    };
    for (let index = 0; index < 10; index += 1) {
      status = nextChatGptWebStatus(status, { succeeded: true });
    }
    expect(status.effectiveConcurrency).toBe(1);
    expect(status.maximumConcurrency).toBe(1);
    expect(status.attemptsAtCurrentLevel).toBe(10);
  });

  it("serializes concurrent web status updates so qualification evidence is not lost", async () => {
    const repository = new InMemoryJobRepository();
    await repository.saveChatGptWebStatus({
      ...defaultChatGptWebStatus(),
      configuredEnabled: true,
      effectiveConcurrency: 1,
      circuitState: "closed",
      circuitReason: null,
    });
    const worker = new WorkerService({
      repository,
      provider: {
        name: "codex",
        invoke: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
      quotaClient: { read: async () => Promise.reject(new Error("offline")) },
    });

    await Promise.all(
      Array.from({ length: 10 }, () =>
        worker.mutateChatGptWebStatus((status) =>
          nextChatGptWebStatus(status, { succeeded: true }),
        ),
      ),
    );

    const persisted = await repository.readChatGptWebStatus();
    expect(persisted.effectiveConcurrency).toBe(1);
    expect(persisted.attemptsAtCurrentLevel).toBe(10);
  });

  it("serializes the complete web dispatch reservation and preserves the 90 second interval", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date("2026-08-31T12:00:00.000Z");
      vi.setSystemTime(startedAt);
      const repository = new InMemoryJobRepository();
      const task = TaskContractSchema.parse({
        objective: "Return a synthetic marker",
        executionChannel: "chatgpt_web",
        model: "chatgpt-web.auto",
        chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
        deadlineMs: 600_000,
      });
      const firstJob = makeJob({ idempotencyKey: "dispatch-one", task });
      const secondJob = makeJob({ idempotencyKey: "dispatch-two", task });
      await repository.create(firstJob);
      await repository.create(secondJob);
      await repository.saveChatGptWebStatus({
        ...defaultChatGptWebStatus(),
        configuredEnabled: true,
        effectiveConcurrency: 1,
        circuitState: "closed",
        circuitReason: null,
        lastQualificationPassed: true,
      });
      await repository.setModelEnabled("chatgpt-web.auto", true, "test");
      const invocationTimes: number[] = [];
      const webInvoke = vi.fn<ModelProvider["invoke"]>(async () => {
        invocationTimes.push(Date.now());
        return {
          output: "SYNTHETIC_OK",
          outputText: "SYNTHETIC_OK",
          threadId: null,
          usage: {
            ...makeJob().usage,
            measurementStatus: "unavailable",
            subscriptionChannel: "chatgpt_pro_web",
            durationMs: 100,
          },
        };
      });
      const worker = new WorkerService({
        repository,
        provider: { name: "codex", invoke: vi.fn() },
        chatgptProvider: { name: "chatgpt_web", workspaceMode: "provider", invoke: webInvoke },
        quotaClient: { read: async () => Promise.reject(new Error("offline")) },
      });

      const firstRun = worker.processJob(firstJob.id);
      const secondRun = worker.processJob(secondJob.id);
      await firstRun;
      expect(webInvoke).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(89_999);
      expect(webInvoke).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await secondRun;

      expect(webInvoke).toHaveBeenCalledTimes(2);
      expect(invocationTimes).toEqual([startedAt.getTime(), startedAt.getTime() + 90_000]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("admits only one expired-cooldown recovery probe and clears observation after 3 successes", async () => {
    const repository = new InMemoryJobRepository();
    const task = TaskContractSchema.parse({
      objective: "Return a synthetic recovery marker",
      executionChannel: "chatgpt_web",
      model: "chatgpt-web.auto",
      chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
      deadlineMs: 600_000,
    });
    const firstJob = makeJob({ idempotencyKey: "recovery-one", task });
    const secondJob = makeJob({ idempotencyKey: "recovery-two", task });
    await repository.create(firstJob);
    await repository.create(secondJob);
    await repository.saveChatGptWebStatus({
      ...defaultChatGptWebStatus(),
      configuredEnabled: true,
      effectiveConcurrency: 0,
      circuitState: "cooldown",
      circuitReason: "chatgpt_rate_limited",
      rateLimitState: "cooldown",
      cooldownUntil: new Date(Date.now() - 1_000).toISOString(),
      retryAfter: 1_800,
      lastRateLimitAt: new Date(Date.now() - 1_801_000).toISOString(),
      consecutiveRateLimits: 1,
      lastQualificationPassed: true,
    });
    await repository.setModelEnabled("chatgpt-web.auto", true, "test");
    let releaseInvocation: () => void = () => undefined;
    const invocationHeld = new Promise<void>((resolve) => {
      releaseInvocation = resolve;
    });
    const webInvoke = vi.fn<ModelProvider["invoke"]>(async () => {
      await invocationHeld;
      return {
        output: "RECOVERY_OK",
        outputText: "RECOVERY_OK",
        threadId: null,
        usage: {
          ...makeJob().usage,
          measurementStatus: "unavailable",
          subscriptionChannel: "chatgpt_pro_web",
          durationMs: 100,
        },
      };
    });
    const worker = new WorkerService({
      repository,
      provider: { name: "codex", invoke: vi.fn() },
      chatgptProvider: { name: "chatgpt_web", workspaceMode: "provider", invoke: webInvoke },
      quotaClient: { read: async () => Promise.reject(new Error("offline")) },
    });

    const firstRun = worker.processJob(firstJob.id);
    const secondRun = worker.processJob(secondJob.id);
    await secondRun;

    expect(webInvoke).toHaveBeenCalledOnce();
    expect((await repository.findById(secondJob.id))?.errorCode).toBe("chatgpt_rate_limited");
    expect((await repository.readChatGptWebStatus()).rateLimitState).toBe("recovery_probe");

    releaseInvocation();
    await firstRun;
    let persisted = await repository.readChatGptWebStatus();
    expect(persisted.rateLimitState).toBe("observation");
    expect(persisted.lastRecoveryProbePassed).toBe(true);
    expect(persisted.successesAtCurrentLevel).toBe(1);

    await worker.mutateChatGptWebStatus((status) =>
      nextChatGptWebStatus(status, { succeeded: true }),
    );
    persisted = await worker.mutateChatGptWebStatus((status) =>
      nextChatGptWebStatus(status, { succeeded: true }),
    );
    expect(persisted.rateLimitState).toBe("clear");
    expect(persisted.consecutiveRateLimits).toBe(0);
    expect(persisted.successesAtCurrentLevel).toBe(3);
  });

  it("opens the web circuit after an ownership-sensitive failure", () => {
    const status = nextChatGptWebStatus(
      {
        ...defaultChatGptWebStatus(),
        configuredEnabled: true,
        effectiveConcurrency: 2,
        circuitState: "closed",
        circuitReason: null,
      },
      { succeeded: false, errorCode: "chatgpt_delivery_uncertain" },
    );
    expect(status.effectiveConcurrency).toBe(0);
    expect(status.circuitState).toBe("qualification_required");
  });

  it("pauses the web channel after three consecutive ordinary failures", () => {
    let status: ChatGptWebStatus = {
      ...defaultChatGptWebStatus(),
      configuredEnabled: true,
      effectiveConcurrency: 1,
      circuitState: "closed",
      circuitReason: null,
    };
    for (let index = 0; index < 3; index += 1) {
      status = nextChatGptWebStatus(status, {
        succeeded: false,
        errorCode: "chatgpt_page_generation_blank",
      });
    }
    expect(status.effectiveConcurrency).toBe(0);
    expect(status.circuitState).toBe("qualification_required");
    expect(status.circuitReason).toBe("consecutive_failures");
  });

  it("never retries a web request automatically", () => {
    expect(isSafeChatGptWebRetry(new Error("chatgpt_page_generation_blank:blank"))).toBe(false);
    expect(isSafeChatGptWebRetry(new Error("chatgpt_output_incomplete_blank:timeout"))).toBe(false);
    expect(isSafeChatGptWebRetry(new Error("chatgpt_page_not_ready:loading"))).toBe(false);
    expect(isSafeChatGptWebRetry(new Error("chatgpt_delivery_uncertain:unknown"))).toBe(false);
    expect(isSafeChatGptWebRetry(new Error("chatgpt_output_incomplete:partial"))).toBe(false);
  });

  it("uses progressive cooldowns after repeated web rate limits", () => {
    const start = new Date("2026-08-31T00:00:00.000Z");
    let status = nextChatGptWebStatus(
      { ...defaultChatGptWebStatus(start), configuredEnabled: true },
      { succeeded: false, errorCode: "chatgpt_rate_limited" },
      start,
    );
    expect(status.rateLimitState).toBe("cooldown");
    expect(status.retryAfter).toBe(1_800);
    expect(status.cooldownUntil).toBe("2026-08-31T00:30:00.000Z");

    status = nextChatGptWebStatus(
      status,
      { succeeded: false, errorCode: "chatgpt_rate_limited" },
      start,
    );
    expect(status.retryAfter).toBe(3_600);

    status = nextChatGptWebStatus(
      status,
      { succeeded: false, errorCode: "chatgpt_rate_limited" },
      start,
    );
    expect(status.retryAfter).toBe(7_200);
  });
});

describe("WorkerService conversation sessions", () => {
  function quotaStub() {
    return { read: async () => Promise.reject(new Error("offline")) };
  }

  function okProvider(threadId: string | null): ModelProvider {
    return {
      name: "codex",
      workspaceMode: "provider",
      invoke: vi.fn(async () => ({
        output: "done",
        outputText: "done",
        threadId,
        usage: makeJob().usage,
      })),
    };
  }

  it("registers a resumable thread after a persistent call succeeds", async () => {
    const repository = new InMemoryJobRepository();
    const job = makeJob({
      task: TaskContractSchema.parse({
        objective: "Start a conversation",
        sessionMode: "persistent",
      }),
    });
    await repository.create(job);
    const worker = new WorkerService({
      repository,
      provider: okProvider("thread-1"),
      quotaClient: quotaStub(),
    });

    await worker.processJob(job.id);

    const thread = await repository.findSessionThread("thread-1");
    expect(thread).not.toBeNull();
    expect(thread?.callerId).toBe("test");
    expect(thread?.turnCount).toBe(1);
    expect((await repository.findById(job.id))?.task.sessionKey).toBe("thread-1");
  });

  it("does not register a thread for ephemeral calls", async () => {
    const repository = new InMemoryJobRepository();
    const job = makeJob();
    await repository.create(job);
    const worker = new WorkerService({
      repository,
      provider: okProvider(null),
      quotaClient: quotaStub(),
    });

    await worker.processJob(job.id);

    expect(await repository.listSessionThreads("test", true)).toHaveLength(0);
  });

  it("fails a resumed call when the thread record is missing", async () => {
    const repository = new InMemoryJobRepository();
    const job = makeJob({
      task: TaskContractSchema.parse({
        objective: "Continue",
        sessionKey: "thread-gone",
        sessionMode: "persistent",
      }),
    });
    await repository.create(job);
    const provider = okProvider("thread-gone");
    const worker = new WorkerService({ repository, provider, quotaClient: quotaStub() });

    await worker.processJob(job.id);

    const completed = await repository.findById(job.id);
    expect(completed?.status).toBe("failed");
    expect(completed?.errorCode).toBe("session_expired");
    expect(provider.invoke).not.toHaveBeenCalled();
  });

  it("increments the turn count when an existing thread is resumed", async () => {
    const repository = new InMemoryJobRepository();
    const now = new Date();
    await repository.upsertSessionThread({
      sessionKey: "thread-1",
      callerId: "test",
      model: "gpt-5.6-terra",
      effort: "medium",
      turnCount: 1,
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const job = makeJob({
      task: TaskContractSchema.parse({
        objective: "Second turn",
        sessionKey: "thread-1",
        sessionMode: "persistent",
      }),
    });
    await repository.create(job);
    const worker = new WorkerService({
      repository,
      provider: okProvider("thread-1"),
      quotaClient: quotaStub(),
    });

    await worker.processJob(job.id);

    expect((await repository.findById(job.id))?.status).toBe("succeeded");
    expect((await repository.findSessionThread("thread-1"))?.turnCount).toBe(2);
  });
});
