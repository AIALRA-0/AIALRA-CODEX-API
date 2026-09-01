import "reflect-metadata";

import { describe, expect, it } from "vitest";

import type { ExecutionPolicy, SessionThread } from "@aialra/contracts";
import { InMemoryJobRepository } from "@aialra/persistence";

import { JobsService } from "../src/jobs/jobs.service.js";
import { NoopJobQueue } from "../src/queue/job-queue.js";
import { QuotaService, UnavailableQuotaProvider } from "../src/quota/quota.service.js";

const FULL_POLICY: ExecutionPolicy = {
  defaultPreset: "full",
  allowedPresets: ["restricted", "confirm", "full"],
};

function makeService(repository: InMemoryJobRepository) {
  return new JobsService(
    repository,
    new NoopJobQueue(),
    new QuotaService(new UnavailableQuotaProvider()),
  );
}

function threadFixture(overrides: Partial<SessionThread> = {}): SessionThread {
  const now = new Date();
  return {
    sessionKey: "thread-1",
    callerId: "caller-1",
    model: "gpt-5.6-terra",
    effort: "medium",
    turnCount: 1,
    createdAt: now.toISOString(),
    lastUsedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    ...overrides,
  };
}

describe("JobsService conversation sessions", () => {
  it("rejects a resume request for an unknown thread with 409", async () => {
    const service = makeService(new InMemoryJobRepository());

    const error = await service
      .create(
        { task: { objective: "Continue", sessionKey: "missing" }, metadata: {} },
        "caller-1",
        "idem-unknown-thread",
        FULL_POLICY,
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      response: { error: { code: "session_expired" } },
      status: 409,
    });
  });

  it("rejects a resume request for an expired thread", async () => {
    const repository = new InMemoryJobRepository();
    await repository.upsertSessionThread(
      threadFixture({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    );
    const service = makeService(repository);

    const error = await service
      .create(
        { task: { objective: "Continue", sessionKey: "thread-1" }, metadata: {} },
        "caller-1",
        "idem-expired-thread",
        FULL_POLICY,
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ response: { error: { code: "session_expired" } } });
  });

  it("forbids resuming another caller's thread", async () => {
    const repository = new InMemoryJobRepository();
    await repository.upsertSessionThread(threadFixture());
    const service = makeService(repository);

    const error = await service
      .create(
        { task: { objective: "Continue", sessionKey: "thread-1" }, metadata: {} },
        "caller-2",
        "idem-foreign-thread",
        FULL_POLICY,
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      response: { error: { code: "session_access_denied" } },
      status: 403,
    });
  });

  it("sticks the resumed conversation to the original model and effort", async () => {
    const repository = new InMemoryJobRepository();
    await repository.upsertSessionThread(threadFixture({ model: "gpt-5.6-sol", effort: "high" }));
    const service = makeService(repository);

    const job = await service.create(
      {
        task: { objective: "Second turn", sessionKey: "thread-1", sessionMode: "persistent" },
        metadata: {},
      },
      "caller-1",
      "idem-sticky-thread",
      FULL_POLICY,
    );

    expect(job.status).toBe("queued");
    expect(job.route).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "high",
      reasonCode: "session_sticky",
      sticky: true,
    });
  });

  it("accepts a persistent first turn without a session key", async () => {
    const service = makeService(new InMemoryJobRepository());

    const job = await service.create(
      { task: { objective: "Start a conversation", sessionMode: "persistent" }, metadata: {} },
      "caller-1",
      "idem-persistent-first",
      FULL_POLICY,
    );

    expect(job.status).toBe("queued");
    expect(job.task.sessionMode).toBe("persistent");
  });
});
