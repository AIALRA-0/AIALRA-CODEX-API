import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { TaskContractSchema, type Job } from "@aialra/contracts";

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
});
