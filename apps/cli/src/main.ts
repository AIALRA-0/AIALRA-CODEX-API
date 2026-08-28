#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { TaskContractSchema, type CreateJobRequest } from "@aialra/contracts";
import { ModelRouterClient } from "@aialra/model-router-client";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function client(): ModelRouterClient {
  const baseUrl = process.env.MODEL_ROUTER_URL ?? "http://127.0.0.1:13210";
  const apiKey = process.env.MODEL_ROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("MODEL_ROUTER_API_KEY is required");
  }
  return new ModelRouterClient({ baseUrl, apiKey });
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonLines(path: string): Promise<CreateJobRequest[]> {
  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CreateJobRequest);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  const router = command === "help" ? null : client();

  if (command === "call") {
    const objective = option("--task");
    if (!objective) {
      throw new Error("call requires --task");
    }
    const task = TaskContractSchema.parse({
      objective,
      model: option("--model") ?? "auto",
      effort: option("--effort") ?? "medium",
      taskKind: option("--kind") ?? "general",
    });
    const response = await router?.createJob(
      { task, metadata: {} },
      option("--idempotency-key") ?? randomUUID(),
    );
    print(
      response && !process.argv.includes("--async")
        ? await router?.waitForJob(response.id, { timeoutMs: task.deadlineMs + 5_000 })
        : response,
    );
  } else if (command === "batch") {
    const path = option("--file");
    if (!path) {
      throw new Error("batch requires --file");
    }
    print(await router?.createBatch(await readJsonLines(path), randomUUID()));
  } else if (command === "jobs") {
    const id = option("--id");
    print(id ? await router?.getJob(id) : await router?.listJobs(Number(option("--limit") ?? 100)));
  } else if (command === "cancel") {
    const id = option("--id");
    if (!id) {
      throw new Error("cancel requires --id");
    }
    print(await router?.cancelJob(id));
  } else if (command === "quota") {
    print(await router?.getQuota());
  } else if (command === "eval") {
    const path = option("--file");
    if (!path) {
      throw new Error("eval requires --file");
    }
    const requests = await readJsonLines(path);
    const jobs = await router?.createBatch(requests, `eval-${randomUUID()}`);
    print({ submitted: jobs?.length ?? 0, jobs });
  } else {
    process.stdout.write(
      "AIALRA Model Router CLI\n\nCommands: call, batch, jobs, cancel, eval, quota\n\nThe call command waits for a terminal result by default. Add --async to return after admission.\n",
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
