import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

import { PgBoss, type Job as QueueJob } from "pg-boss";

import { configuredChatGptWebAccountConfigs, PostgresJobRepository } from "@aialra/persistence";
import {
  ChatGptWebDiagnosticClient,
  processChatGptWebQualification,
} from "./chatgpt-qualification.js";
import { RunnerClientProvider, RunnerQuotaClient } from "./runner-client.js";
import { ChatGptWebPoolProvider } from "./chatgpt-web-pool.js";
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
  const chatgptBridgeToken = requiredEnvironment("CHATGPT_BRIDGE_API_TOKEN");
  const chatgptDiagnosticToken = requiredEnvironment("CHATGPT_WEB_DIAGNOSTIC_TOKEN");
  const chatgptAccountConfigs = configuredChatGptWebAccountConfigs();
  const chatgptWebPool = new ChatGptWebPoolProvider(
    repository,
    chatgptAccountConfigs,
    chatgptBridgeToken,
    chatgptWebEnabled,
  );
  await chatgptWebPool.syncAccounts();
  const chatgptProvider = chatgptWebEnabled ? chatgptWebPool : undefined;
  const codexConcurrency = Math.max(1, Number(process.env.CODEX_MAX_CONCURRENCY ?? 1));
  const chatgptConcurrency = chatgptWebEnabled ? chatgptAccountConfigs.length : 0;
  const codexPool = new PermitPool(codexConcurrency);
  const chatgptPermitPool = chatgptConcurrency
    ? new PermitPool(async () => Math.max(1, await chatgptWebPool.capacity()))
    : null;

  const runtimeClient = new RunnerQuotaClient(runnerUrl, runnerApiToken);
  const service = new WorkerService({
    repository,
    provider,
    chatgptProvider,
    chatgptPool: chatgptWebPool,
    quotaClient: runtimeClient,
  });
  const chatgptQualificationClients = new Map(
    chatgptAccountConfigs.map((config) => [
      config.accountId,
      new ChatGptWebDiagnosticClient(
        config.bridgeUrl,
        chatgptBridgeToken,
        chatgptDiagnosticToken,
        config.accountId,
      ),
    ]),
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
        const pool =
          queued?.task.executionChannel === "chatgpt_web" ? chatgptPermitPool : codexPool;
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
          const qualificationRun = await repository.findChatGptWebQualificationRun(
            queuedRun.data.runId,
          );
          const qualificationClient =
            (qualificationRun?.accountId
              ? chatgptQualificationClients.get(qualificationRun.accountId)
              : chatgptQualificationClients.get("account-a")) ??
            [...chatgptQualificationClients.values()][0];
          if (!qualificationClient) throw new Error("chatgpt_browser_unavailable");
          await processChatGptWebQualification(
            repository,
            qualificationClient,
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
      await chatgptWebPool.refreshHealth();
      const [quota, codexModels, chatgptModels] = await Promise.allSettled([
        runtimeClient.read(),
        runtimeClient.listModels(),
        chatgptWebPool.listModels(),
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
      const poolStatus = await chatgptWebPool.refreshAggregateStatus();
      await service.mutateChatGptWebStatus((currentWebStatus) => {
        return {
          ...currentWebStatus,
          ...poolStatus,
          queuedJobs,
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
