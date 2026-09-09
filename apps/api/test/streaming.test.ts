import "reflect-metadata";
import { EventEmitter } from "node:events";
import type { Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskContractSchema, UsageLedgerSchema, type Job, type JobEvent } from "@aialra/contracts";
import {
  configuredChatGptWebAccountConfigs,
  defaultChatGptWebStatus,
  InMemoryJobRepository,
} from "@aialra/persistence";
import { ChatCompletionsController } from "../src/chat/chat.controller.js";
import { ResponsesController } from "../src/responses/responses.controller.js";
import { openEventStream } from "../src/common/sse.js";
import type { AuthenticatedRequest } from "../src/common/api-key.guard.js";
import { JobsService } from "../src/jobs/jobs.service.js";
import { NoopJobQueue } from "../src/queue/job-queue.js";
import { QuotaService, UnavailableQuotaProvider } from "../src/quota/quota.service.js";

function responseFixture() {
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  const response = Object.assign(emitter, {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    end: vi.fn(),
    destroyed: false,
    writableEnded: false,
  });
  return { response: response as unknown as Response, chunks, emitter };
}

afterEach(() => vi.useRealTimers());

describe("stream delivery", () => {
  it("derives late retry hints from real account/global state and leaves Codex errors alone", async () => {
    const repository = new InMemoryJobRepository();
    await repository.syncChatGptWebAccounts(configuredChatGptWebAccountConfigs("a,b"));
    for (const [accountId, retryAfter] of [
      ["account-a", 600],
      ["account-b", 1200],
    ] as const) {
      await repository.updateChatGptWebAccount(accountId, {
        enabled: true,
        qualified: true,
        state: "cooldown",
        rateLimitState: "cooldown",
        lastRateLimitAt: new Date(Date.now() - 100_000).toISOString(),
        retryAfter,
      });
    }
    const service = new JobsService(
      repository,
      new NoopJobQueue(),
      new QuotaService(new UnavailableQuotaProvider()),
    );
    const job = { errorCode: "chatgpt_rate_limited" } as Job;
    expect(await service.retryAfterFor(job)).toBeGreaterThanOrEqual(499);
    expect(await service.retryAfterFor(job)).toBeLessThanOrEqual(500);
    await repository.saveChatGptWebStatus({
      ...defaultChatGptWebStatus(),
      rateLimitState: "cooldown",
      cooldownUntil: new Date(Date.now() + 900_000).toISOString(),
    });
    expect(await service.retryAfterFor(job)).toBeGreaterThanOrEqual(899);
    expect(await service.retryAfterFor({ errorCode: "codex_unauthorized" } as Job)).toBeUndefined();
  });

  it.each(
    ["chat", "responses"].flatMap((kind) => [false, true].map((stream) => ({ kind, stream }))),
  )("$kind preserves late rate limits with stream=$stream", async ({ kind, stream }) => {
    const job = {
      id: "00000000-0000-4000-8000-000000000001",
      task: TaskContractSchema.parse({
        objective: "Synthetic",
        model: "chatgpt-web.auto",
        executionChannel: "chatgpt_web",
        chatgptWeb: { mode: "chat" },
      }),
      status: "failed",
      errorCode: "chatgpt_rate_limited",
      errorMessage: "Synthetic cooldown",
      usage: UsageLedgerSchema.parse({}),
      createdAt: new Date().toISOString(),
    } as Job;
    const retryAfterFor = vi.fn(async () => 123);
    const jobs = {
      create: vi.fn(async () => job),
      get: vi.fn(async () => job),
      waitForTerminal: vi.fn(async () => job),
      retryAfterFor,
      streamEvents: async function* () {
        yield { type: "status", data: {} };
      },
    } as unknown as JobsService;
    const { response, chunks } = responseFixture();
    const controller =
      kind === "chat" ? new ChatCompletionsController(jobs) : new ResponsesController(jobs);
    await controller.create(
      {
        model: "chatgpt-web.auto",
        stream,
        ...(kind === "chat"
          ? { messages: [{ role: "user", content: "Synthetic" }] }
          : { input: "Synthetic" }),
      },
      { header: () => "synthetic-rate-key" } as unknown as AuthenticatedRequest,
      response,
    );
    expect(retryAfterFor).toHaveBeenCalledOnce();
    if (stream) {
      expect(chunks.join("")).toContain('"code":"chatgpt_rate_limited"');
      expect(chunks.join("")).toContain('"retryAfter":123');
      expect(chunks.at(-1)).toBe("data: [DONE]\n\n");
      expect(response.setHeader).not.toHaveBeenCalledWith("Retry-After", expect.anything());
    } else {
      expect(response.status).toHaveBeenCalledWith(429);
      expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "123");
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: "chatgpt_rate_limited", retryAfter: 123 }),
        }),
      );
    }
    expect(jobs.create).toHaveBeenCalledOnce();
  });

  it("drains output committed between the event query and terminal status query", async () => {
    const service = new JobsService(
      new InMemoryJobRepository(),
      new NoopJobQueue(),
      new QuotaService(new UnavailableQuotaProvider()),
    );
    const event: JobEvent = {
      id: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000001",
      createdAt: new Date().toISOString(),
      sequence: 1,
      type: "output.delta",
      data: { delta: "final" },
    };
    vi.spyOn(service, "events").mockResolvedValueOnce([]).mockResolvedValueOnce([event]);
    vi.spyOn(service, "get").mockResolvedValue({ status: "succeeded" } as Job);
    const received = [];
    for await (const item of service.streamEvents("test")) received.push(item);
    expect(received).toEqual([event]);
  });

  it("sends heartbeat comments and stops the reader on disconnect", () => {
    vi.useFakeTimers();
    const { response, chunks, emitter } = responseFixture();
    const stream = openEventStream(response);
    vi.advanceTimersByTime(15_000);
    expect(chunks).toEqual([": keep-alive\n\n"]);
    expect(response.setHeader).toHaveBeenCalledWith("X-Accel-Buffering", "no");
    emitter.emit("close");
    expect(stream.signal.aborted).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(chunks).toHaveLength(1);
    expect(emitter.listenerCount("close")).toBe(0);
  });

  it.each(["chat", "responses"])("%s returns final-only output exactly once", async (kind) => {
    const task = TaskContractSchema.parse({ objective: "Synthetic", model: "luna" });
    const job = {
      id: "00000000-0000-4000-8000-000000000001",
      task,
      status: "succeeded",
      output: "FINAL_MARKER",
      route: null,
      createdAt: new Date().toISOString(),
      usage: UsageLedgerSchema.parse({}),
    } as Job;
    const jobs = {
      create: vi.fn(async () => job),
      get: vi.fn(async () => job),
      streamEvents: async function* () {
        yield { type: "status", data: {} };
      },
    } as unknown as JobsService;
    const request = {
      header: () => "synthetic-idempotency",
      scopes: [],
    } as unknown as AuthenticatedRequest;
    const { response, chunks, emitter } = responseFixture();
    if (kind === "chat") {
      await new ChatCompletionsController(jobs).create(
        {
          model: "luna",
          messages: [{ role: "user", content: "Synthetic" }],
          stream: true,
          stream_options: { include_usage: true },
        },
        request,
        response,
      );
      const frames = chunks
        .filter((chunk) => chunk.startsWith("data: {"))
        .map((chunk) => JSON.parse(chunk.slice(6)));
      expect(
        frames.filter((frame) =>
          frame.choices.some(
            (choice: { delta: { content?: string } }) => choice.delta.content === "FINAL_MARKER",
          ),
        ),
      ).toHaveLength(1);
      expect(frames.find((frame) => frame.usage)?.choices).toEqual([]);
    } else {
      await new ResponsesController(jobs).create(
        { model: "luna", input: "Synthetic", stream: true },
        request,
        response,
      );
      expect(chunks.filter((chunk) => chunk.includes('"delta":"FINAL_MARKER"'))).toHaveLength(1);
    }
    expect(chunks.at(-1)).toBe("data: [DONE]\n\n");
    expect(response.end).toHaveBeenCalledOnce();
    expect(emitter.listenerCount("close")).toBe(0);
  });
});
