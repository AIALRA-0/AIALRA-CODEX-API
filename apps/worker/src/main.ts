import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

import { PgBoss, type Job as QueueJob } from "pg-boss";

import { PostgresJobRepository } from "@aialra/persistence";
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

async function main(): Promise<void> {
  const databaseUrl = requiredEnvironment("DATABASE_URL");
  const masterKey = requiredEnvironment("PAYLOAD_MASTER_KEY");
  const repository = new PostgresJobRepository(databaseUrl, masterKey);
  await repository.migrate();

  const runnerUrl = process.env.RUNNER_URL ?? "http://runner:13214";
  const provider = new RunnerClientProvider(runnerUrl);

  const runtimeClient = new RunnerQuotaClient(runnerUrl);
  const service = new WorkerService({
    repository,
    provider,
    quotaClient: runtimeClient,
  });
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  await boss.start();
  await boss.createQueue("model-router-jobs");
  await boss.work<{ jobId: string }>(
    "model-router-jobs",
    { localConcurrency: Number(process.env.CODEX_MAX_CONCURRENCY ?? 1) },
    async (jobs: QueueJob<{ jobId: string }>[]) => {
      for (const queueJob of jobs) {
        await service.processJob(queueJob.data.jobId, queueJob.signal);
      }
    },
  );

  const retentionTimer = setInterval(() => {
    void repository.deleteExpiredPayloads(new Date());
    void repository.deleteExpiredMetadata(new Date());
  }, 3_600_000);
  retentionTimer.unref();

  let runtimeRefreshActive = false;
  const refreshRuntimeState = async () => {
    if (runtimeRefreshActive) return;
    runtimeRefreshActive = true;
    try {
      const [quota, models] = await Promise.allSettled([
        runtimeClient.read(),
        runtimeClient.listModels(),
      ]);
      if (quota.status === "fulfilled") await repository.saveQuotaSnapshot(quota.value);
      if (models.status === "fulfilled") await repository.saveModelCatalog(models.value);
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
        `aialra_worker_concurrency ${Number(process.env.CODEX_MAX_CONCURRENCY ?? 1)}`,
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
