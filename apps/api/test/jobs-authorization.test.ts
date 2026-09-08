import { describe, expect, it } from "vitest";

import { TaskContractSchema } from "@aialra/contracts";
import { InMemoryJobRepository } from "@aialra/persistence";

import { JobsService } from "../src/jobs/jobs.service.js";

describe("job object authorization", () => {
  it("prevents one API key from reading or cancelling another key's job", async () => {
    const repository = new InMemoryJobRepository();
    const queue = {
      enqueue: async () => undefined,
      enqueueChatGptWebQualification: async () => undefined,
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const service = new JobsService(repository, queue, {
      read: async () => ({
        provider: "codex",
        usedPercent: 1,
        windowDurationMinutes: 300,
        resetsAt: null,
        planType: "pro",
        fetchedAt: new Date().toISOString(),
        source: "app-server",
        windows: [],
        stale: false,
      }),
    } as never);
    const job = await service.create(
      {
        task: TaskContractSchema.parse({ objective: "synthetic owner test", taskKind: "bounded" }),
        metadata: {},
      },
      "key-a",
      "owner-test",
    );

    await expect(service.getForActor(job.id, "key-b", false)).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.cancelForActor(job.id, "key-b", false)).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.getForActor(job.id, "admin", true)).resolves.toMatchObject({ id: job.id });
  });

  it("allows Codex to return its precise runtime error when only web models are discoverable", async () => {
    const repository = new InMemoryJobRepository();
    const discoveredAt = new Date().toISOString();
    await repository.saveModelCatalog({
      source: "chatgpt-web",
      fetchedAt: discoveredAt,
      models: [
        {
          id: "chatgpt-web.auto",
          displayName: "ChatGPT Web Auto",
          provider: "chatgpt_web",
          available: true,
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: ["minimal"],
          defaultReasoningEffort: "minimal",
          inputModalities: ["text"],
          creditRate: null,
          apiRate: null,
          rateStatus: "unavailable",
          streamingMode: "final_only",
          discoveredAt,
        },
      ],
    });
    let enqueued = 0;
    const service = new JobsService(
      repository,
      {
        enqueue: async () => {
          enqueued += 1;
        },
        enqueueChatGptWebQualification: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      },
      {
        read: async () => ({
          provider: "codex",
          usedPercent: null,
          windowDurationMinutes: null,
          resetsAt: null,
          planType: null,
          fetchedAt: discoveredAt,
          source: "unavailable",
          windows: [],
          stale: true,
        }),
      } as never,
    );

    const job = await service.create(
      {
        task: TaskContractSchema.parse({
          objective: "synthetic unavailable-provider test",
          executionChannel: "codex",
          model: "gpt-5.6-luna",
        }),
        metadata: {},
      },
      "key-a",
      "provider-runtime-test",
    );

    expect(job.status).toBe("queued");
    expect(enqueued).toBe(1);
  });
});
