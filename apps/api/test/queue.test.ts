import { describe, expect, it, vi } from "vitest";
import { PgBossJobQueue, queueExpirationSeconds } from "../src/queue/job-queue.js";

describe("channel queue isolation", () => {
  it("dispatches channels into separate queues and never enables automatic job retry", async () => {
    const queue = new PgBossJobQueue("postgresql://unused:unused@127.0.0.1:1/unused");
    const boss = { start: vi.fn(), createQueue: vi.fn(), send: vi.fn(), cancel: vi.fn() };
    Object.defineProperty(queue, "boss", { value: boss });
    await queue.enqueue("codex-job", "codex", 480_000);
    await queue.enqueue("web-job", "chatgpt_web", 3_600_000);
    expect(boss.send).toHaveBeenNthCalledWith(
      1,
      "model-router-codex-jobs",
      { jobId: "codex-job" },
      {
        id: "codex-job",
        singletonKey: "codex-job",
        retryLimit: 0,
        expireInSeconds: 780,
      },
    );
    expect(boss.send).toHaveBeenNthCalledWith(
      2,
      "model-router-chatgpt-jobs",
      { jobId: "web-job" },
      {
        id: "web-job",
        singletonKey: "web-job",
        retryLimit: 0,
        expireInSeconds: 3_900,
      },
    );
    await queue.cancel("web-job");
    expect(boss.cancel).toHaveBeenCalledWith("model-router-jobs", "web-job");
    expect(boss.cancel).toHaveBeenCalledWith("model-router-chatgpt-jobs", "web-job");
  });

  it("adds result persistence grace to each task deadline", () => {
    expect(queueExpirationSeconds(3_600_000)).toBe(3_900);
    expect(queueExpirationSeconds(Number.NaN)).toBe(420);
  });
});
