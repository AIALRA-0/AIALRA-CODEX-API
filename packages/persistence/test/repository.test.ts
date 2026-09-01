import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ChatGptWebQualificationRunSchema,
  TaskContractSchema,
  type Job,
  type SessionThread,
} from "@aialra/contracts";

import { InMemoryJobRepository } from "../src/index.js";

function jobFixture(): Job {
  const now = new Date();
  return {
    id: randomUUID(),
    status: "accepted" as const,
    requestHash: "hash",
    idempotencyKey: "key",
    callerId: "caller",
    task: TaskContractSchema.parse({ objective: "Run a test" }),
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
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  };
}

function sessionThreadFixture(overrides: Partial<SessionThread> = {}): SessionThread {
  const now = Date.now();
  return {
    sessionKey: "session-1",
    callerId: "caller",
    model: "gpt-5.6-luna",
    effort: "medium",
    turnCount: 1,
    createdAt: new Date(now).toISOString(),
    lastUsedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    ...overrides,
  };
}

describe("InMemoryJobRepository", () => {
  it("preserves idempotency lookup", async () => {
    const repository = new InMemoryJobRepository();
    await repository.create(jobFixture());

    expect(await repository.findByIdempotency("caller", "key")).not.toBeNull();
  });

  it("sequences events", async () => {
    const repository = new InMemoryJobRepository();
    const job = await repository.create(jobFixture());
    await repository.appendEvent(job.id, "status", { status: "queued" });
    await repository.appendEvent(job.id, "status", { status: "running" });

    expect((await repository.events(job.id)).map((event) => event.sequence)).toEqual([0, 1]);
  });

  it("records a status transition and its audit together", async () => {
    const repository = new InMemoryJobRepository();
    const job = await repository.create(jobFixture());
    const createdAt = new Date().toISOString();

    await repository.transitionJob(
      job.id,
      { status: "queued" },
      {
        id: randomUUID(),
        actorId: "caller",
        action: "job.queued",
        resourceType: "job",
        resourceId: job.id,
        metadata: {},
        createdAt,
      },
    );

    expect((await repository.findById(job.id))?.status).toBe("queued");
    expect(await repository.events(job.id)).toMatchObject([{ data: { status: "queued" } }]);
    expect(await repository.listAudit()).toMatchObject([{ action: "job.queued" }]);
  });

  it("creates a deletion receipt when an expired payload is removed", async () => {
    const repository = new InMemoryJobRepository();
    const job = jobFixture();
    job.output = { private: "payload" };
    job.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await repository.create(job);
    await repository.appendEvent(job.id, "output.delta", { delta: "private event" });

    expect(await repository.deleteExpiredPayloads(new Date())).toBe(1);
    expect((await repository.findById(job.id))?.task.objective).toBe("[deleted]");
    expect(await repository.events(job.id)).toHaveLength(0);
    expect(await repository.listDeletionReceipts()).toHaveLength(1);
  });

  it("removes job metadata after ninety days", async () => {
    const repository = new InMemoryJobRepository();
    const job = jobFixture();
    job.createdAt = new Date(Date.now() - 91 * 86_400_000).toISOString();
    await repository.create(job);

    expect(await repository.deleteExpiredMetadata(new Date())).toBe(1);
    expect(await repository.findById(job.id)).toBeNull();
  });

  it("creates an API key once for the same idempotency request", async () => {
    const repository = new InMemoryJobRepository();
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      createdBy: "actor",
      name: "Synthetic key",
      prefix: "amr_000000000000",
      digest: "synthetic-digest",
      scopes: ["jobs:read"],
      executionPolicy: {
        defaultPreset: "restricted" as const,
        allowedPresets: ["restricted" as const],
      },
      rateLimitPerMinute: 60,
      expiresAt: null,
      revokedAt: null,
      createdAt: now,
      lastUsedAt: null,
    };
    const first = await repository.createApiKeyIdempotent(
      "actor",
      "request-key",
      "request-hash",
      record,
      "synthetic-plaintext",
    );
    const second = await repository.createApiKeyIdempotent(
      "actor",
      "request-key",
      "request-hash",
      { ...record, id: randomUUID() },
      "different-plaintext",
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.record.id).toBe(record.id);
    expect(await repository.apiKeyCount()).toBe(1);
  });

  it("inserts then replaces a session thread on upsert", async () => {
    const repository = new InMemoryJobRepository();
    const thread = sessionThreadFixture({ sessionKey: "session-1" });

    const inserted = await repository.upsertSessionThread(thread);
    expect(inserted.turnCount).toBe(1);

    const replaced = await repository.upsertSessionThread({
      ...thread,
      turnCount: thread.turnCount + 1,
      lastUsedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    expect(replaced.turnCount).toBe(2);
    expect((await repository.findSessionThread("session-1"))?.turnCount).toBe(2);
  });

  it("finds a session thread by key and returns null for a miss", async () => {
    const repository = new InMemoryJobRepository();
    await repository.upsertSessionThread(sessionThreadFixture({ sessionKey: "session-1" }));

    expect(await repository.findSessionThread("session-1")).toMatchObject({
      sessionKey: "session-1",
      callerId: "caller",
    });
    expect(await repository.findSessionThread("missing")).toBeNull();
  });

  it("lists session threads for the caller, all for admins, ordered by last use", async () => {
    const repository = new InMemoryJobRepository();
    const now = Date.now();
    await repository.upsertSessionThread(
      sessionThreadFixture({
        sessionKey: "mine-old",
        callerId: "caller",
        lastUsedAt: new Date(now - 2_000).toISOString(),
      }),
    );
    await repository.upsertSessionThread(
      sessionThreadFixture({
        sessionKey: "other",
        callerId: "other-caller",
        lastUsedAt: new Date(now - 1_000).toISOString(),
      }),
    );
    await repository.upsertSessionThread(
      sessionThreadFixture({
        sessionKey: "mine-new",
        callerId: "caller",
        lastUsedAt: new Date(now).toISOString(),
      }),
    );

    const mine = await repository.listSessionThreads("caller", false);
    expect(mine.map((thread) => thread.sessionKey)).toEqual(["mine-new", "mine-old"]);

    const all = await repository.listSessionThreads("caller", true);
    expect(all.map((thread) => thread.sessionKey)).toEqual(["mine-new", "other", "mine-old"]);

    const limited = await repository.listSessionThreads("caller", true, 2);
    expect(limited).toHaveLength(2);
  });

  it("deletes only expired session threads and returns the count", async () => {
    const repository = new InMemoryJobRepository();
    const now = Date.now();
    await repository.upsertSessionThread(
      sessionThreadFixture({
        sessionKey: "expired",
        expiresAt: new Date(now - 1_000).toISOString(),
      }),
    );
    await repository.upsertSessionThread(
      sessionThreadFixture({
        sessionKey: "active",
        expiresAt: new Date(now + 86_400_000).toISOString(),
      }),
    );

    expect(await repository.deleteExpiredSessionThreads(new Date(now))).toBe(1);
    expect(await repository.findSessionThread("expired")).toBeNull();
    expect(await repository.findSessionThread("active")).not.toBeNull();
    expect(await repository.deleteExpiredSessionThreads(new Date(now))).toBe(0);
  });

  it("persists only the secret-free ChatGPT web qualification record", async () => {
    const repository = new InMemoryJobRepository();
    const now = new Date().toISOString();
    const run = ChatGptWebQualificationRunSchema.parse({
      id: randomUUID(),
      suite: "chat_3",
      status: "accepted",
      total: 3,
      completed: 0,
      succeeded: 0,
      failed: 0,
      items: [],
      errorCode: null,
      createdBy: "admin",
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    });

    await repository.createChatGptWebQualificationRun(run);
    const updated = await repository.updateChatGptWebQualificationRun(run.id, {
      status: "running",
      startedAt: now,
    });

    expect(updated.status).toBe("running");
    expect(await repository.findChatGptWebQualificationRun(run.id)).toMatchObject({
      id: run.id,
      suite: "chat_3",
    });
    expect(await repository.listChatGptWebQualificationRuns()).toHaveLength(1);
  });
});
