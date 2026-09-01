import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

import { PgBoss, type Job as QueueJob } from "pg-boss";

import type { ChatGptWebStatus } from "@aialra/contracts";
import { PostgresJobRepository } from "@aialra/persistence";
import {
  ChatGptWebDiagnosticClient,
  processChatGptWebQualification,
} from "./chatgpt-qualification.js";
import { RunnerClientProvider, RunnerQuotaClient } from "./runner-client.js";
import { WorkerService } from "./worker.service.js";

function requiredEnvironment(name: string): string {
  const secretPath = process.env[`${name}_FILE`];
  if (secretPath && existsSync(secretPath)) {
    return readFileSync(secretPath, "utf8").trim();
  }
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

class PermitPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number | (() => Promise<number>)) {}

  private async currentLimit(): Promise<number> {
    return typeof this.limit === "number" ? this.limit : this.limit();
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    while (this.active >= Math.max(1, await this.currentLimit())) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        timer.unref();
      });
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = requiredEnvironment("DATABASE_URL");
  const masterKey = requiredEnvironment("PAYLOAD_MASTER_KEY");
  const repository = new PostgresJobRepository(databaseUrl, masterKey);
  await repository.migrate();

  const runnerUrl = process.env.RUNNER_URL ?? "http://runner:13214";
  const runnerApiToken = requiredEnvironment("RUNNER_API_TOKEN");
  const provider = new RunnerClientProvider(runnerUrl, runnerApiToken);
  const chatgptWebEnabled = process.env.CHATGPT_WEB_ADAPTER_ENABLED === "true";
  const chatgptBridgeUrl = process.env.CHATGPT_BRIDGE_URL ?? "http://chatgpt-bridge:13216";
  const chatgptBridgeToken = requiredEnvironment("CHATGPT_BRIDGE_API_TOKEN");
  const chatgptDiagnosticToken = requiredEnvironment("CHATGPT_WEB_DIAGNOSTIC_TOKEN");
  const chatgptProvider = chatgptWebEnabled
    ? new RunnerClientProvider(chatgptBridgeUrl, chatgptBridgeToken, "chatgpt_web")
    : undefined;
  const codexConcurrency = Math.max(1, Number(process.env.CODEX_MAX_CONCURRENCY ?? 1));
  const chatgptConcurrency = chatgptWebEnabled ? 1 : 0;
  const codexPool = new PermitPool(codexConcurrency);
  const chatgptPool = chatgptConcurrency
    ? new PermitPool(async () =>
        Math.min(1, (await repository.readChatGptWebStatus()).effectiveConcurrency),
      )
    : null;

  const runtimeClient = new RunnerQuotaClient(runnerUrl, runnerApiToken);
  const chatgptRuntimeClient = new RunnerQuotaClient(chatgptBridgeUrl, chatgptBridgeToken);
  const service = new WorkerService({
    repository,
    provider,
    chatgptProvider,
    quotaClient: runtimeClient,
  });
  const chatgptQualificationClient = new ChatGptWebDiagnosticClient(
    chatgptBridgeUrl,
    chatgptBridgeToken,
    chatgptDiagnosticToken,
  );
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  await boss.start();
  await boss.createQueue("model-router-jobs");
  await boss.createQueue("chatgpt-web-qualifications");
  await boss.work<{ jobId: string }>(
    "model-router-jobs",
    { localConcurrency: codexConcurrency + chatgptConcurrency },
    async (jobs: QueueJob<{ jobId: string }>[]) => {
      for (const queueJob of jobs) {
        const queued = await repository.findById(queueJob.data.jobId);
        const pool = queued?.task.executionChannel === "chatgpt_web" ? chatgptPool : codexPool;
        if (!pool) {
          await service.processJob(queueJob.data.jobId, queueJob.signal);
        } else {
          await pool.run(() => service.processJob(queueJob.data.jobId, queueJob.signal));
        }
      }
    },
  );
  await boss.work<{ runId: string }>(
    "chatgpt-web-qualifications",
    { localConcurrency: 1 },
    async (runs: QueueJob<{ runId: string }>[]) => {
      for (const queuedRun of runs) {
        try {
          await processChatGptWebQualification(
            repository,
            chatgptQualificationClient,
            queuedRun.data.runId,
          );
        } catch (error) {
          await repository
            .updateChatGptWebQualificationRun(queuedRun.data.runId, {
              status: "failed",
              errorCode:
                error instanceof Error
                  ? error.message.split(":", 1)[0]!.slice(0, 128)
                  : "qualification_worker_failed",
              completedAt: new Date().toISOString(),
            })
            .catch(() => undefined);
        }
      }
    },
  );

  const retentionTimer = setInterval(() => {
    void repository.deleteExpiredPayloads(new Date());
    void repository.deleteExpiredMetadata(new Date());
    void repository.deleteExpiredSessionThreads(new Date());
  }, 3_600_000);
  retentionTimer.unref();

  let runtimeRefreshActive = false;
  const refreshRuntimeState = async () => {
    if (runtimeRefreshActive) return;
    runtimeRefreshActive = true;
    try {
      const [quota, codexModels, chatgptModels, chatgptHealth] = await Promise.allSettled([
        runtimeClient.read(),
        runtimeClient.listModels(),
        chatgptRuntimeClient.listModels(),
        chatgptRuntimeClient.readHealth(),
      ]);
      if (quota.status === "fulfilled") await repository.saveQuotaSnapshot(quota.value);
      const catalogs = [
        codexModels.status === "fulfilled" ? codexModels.value : null,
        chatgptModels.status === "fulfilled" ? chatgptModels.value : null,
      ].filter((catalog): catalog is NonNullable<typeof catalog> => Boolean(catalog));
      const firstCatalog = catalogs[0];
      if (firstCatalog) {
        await repository.saveModelCatalog({
          source: catalogs.length > 1 ? "combined" : firstCatalog.source,
          fetchedAt: new Date().toISOString(),
          models: catalogs.flatMap((catalog) => catalog.models),
        });
      }
      const queuedJobs = (await repository.list(500)).filter(
        (job) =>
          job.task.executionChannel === "chatgpt_web" &&
          ["accepted", "queued"].includes(job.status),
      ).length;
      const health = chatgptHealth.status === "fulfilled" ? chatgptHealth.value : {};
      const slotStates = new Set<ChatGptWebStatus["slots"][number]["state"]>([
        "starting",
        "idle",
        "preparing",
        "ready",
        "submitted",
        "generating",
        "completed",
        "quarantined",
      ]);
      const slots: ChatGptWebStatus["slots"] = Array.isArray(health.slots)
        ? health.slots
            .filter((slot): slot is Record<string, unknown> => {
              if (!slot || typeof slot !== "object") return false;
              return /^[a-f0-9-]{36}$/i.test(
                String((slot as Record<string, unknown>).slotId ?? ""),
              );
            })
            .map((slot) => {
              const stateValue = String(
                slot.state ?? "starting",
              ) as ChatGptWebStatus["slots"][number]["state"];
              return {
                slotId: String(slot.slotId),
                state: slotStates.has(stateValue) ? stateValue : "starting",
                submitted: slot.submitted === true,
                quarantinedUntil:
                  typeof slot.quarantinedUntil === "string" ? slot.quarantinedUntil : null,
                updatedAt:
                  typeof slot.updatedAt === "string" ? slot.updatedAt : new Date().toISOString(),
              };
            })
        : [];
      await service.mutateChatGptWebStatus((currentWebStatus) => {
        return {
          ...currentWebStatus,
          configuredEnabled: chatgptWebEnabled,
          effectiveConcurrency:
            chatgptWebEnabled &&
            !["open", "qualification_required"].includes(currentWebStatus.circuitState) &&
            currentWebStatus.rateLimitState !== "cooldown"
              ? 1
              : 0,
          maximumConcurrency: 1,
          activeTabs: Number(health.activeTabs ?? 0),
          adapterVersion:
            typeof health.adapterVersion === "string"
              ? health.adapterVersion.slice(0, 64)
              : currentWebStatus.adapterVersion,
          quarantinedTabs: 0,
          slots,
          phase:
            typeof health.phase === "string"
              ? (health.phase as ChatGptWebStatus["phase"])
              : currentWebStatus.phase,
          activeJobId: typeof health.activeJobId === "string" ? health.activeJobId : null,
          activeAttempt: typeof health.activeAttempt === "number" ? health.activeAttempt : null,
          lastHeartbeatAt:
            typeof health.lastHeartbeatAt === "string" ? health.lastHeartbeatAt : null,
          lastFailureCode:
            typeof health.lastFailureCode === "string" ? health.lastFailureCode : null,
          lastResetAt: typeof health.lastResetAt === "string" ? health.lastResetAt : null,
          lastSubmissionAt:
            typeof health.lastSubmissionAt === "string"
              ? health.lastSubmissionAt
              : currentWebStatus.lastSubmissionAt,
          temporaryChatVerified: health.temporaryChatVerified === true,
          queuedJobs,
          sandboxVerified: health.sandboxVerified === true,
          extensionConnected: health.extensionConnected === true,
          pageReady: health.pageReady === true,
          authenticated: health.authenticated === true,
          updatedAt: new Date().toISOString(),
        };
      });
    } finally {
      runtimeRefreshActive = false;
    }
  };
  await refreshRuntimeState();
  const runtimeRefreshTimer = setInterval(() => void refreshRuntimeState(), 5_000);
  runtimeRefreshTimer.unref();

  const metricsPort = Number(process.env.METRICS_PORT ?? 13212);
  const metricsServer = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", service: "aialra-model-router-worker" }));
      return;
    }
    const memory = process.memoryUsage();
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    response.end(
      [
        "# HELP aialra_worker_up Whether the worker process is running.",
        "# TYPE aialra_worker_up gauge",
        "aialra_worker_up 1",
        "# HELP aialra_worker_resident_memory_bytes Worker resident memory.",
        "# TYPE aialra_worker_resident_memory_bytes gauge",
        `aialra_worker_resident_memory_bytes ${memory.rss}`,
        "# HELP aialra_worker_concurrency Configured local worker concurrency.",
        "# TYPE aialra_worker_concurrency gauge",
        `aialra_worker_concurrency ${codexConcurrency + chatgptConcurrency}`,
        "# HELP aialra_worker_codex_concurrency Configured Codex concurrency.",
        "# TYPE aialra_worker_codex_concurrency gauge",
        `aialra_worker_codex_concurrency ${codexConcurrency}`,
        "# HELP aialra_worker_chatgpt_web_concurrency Configured ChatGPT web concurrency.",
        "# TYPE aialra_worker_chatgpt_web_concurrency gauge",
        `aialra_worker_chatgpt_web_concurrency ${chatgptConcurrency}`,
        "",
      ].join("\n"),
    );
  });
  metricsServer.listen(metricsPort, "0.0.0.0");

  const shutdown = async () => {
    clearInterval(retentionTimer);
    clearInterval(runtimeRefreshTimer);
    await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
    await boss.stop({ graceful: true, timeout: 30_000 });
    await repository.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

await main();
