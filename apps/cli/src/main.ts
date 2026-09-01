#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  TaskContractSchema,
  type CreateJobRequest,
  type PermissionPreset,
  type ReasoningEffort,
} from "@aialra/contracts";
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
    const executionChannel =
      (option("--channel") as "codex" | "chatgpt_web" | undefined) ?? "codex";
    const chatgptMode =
      (option("--chatgpt-mode") as "chat" | "search" | "deep_research" | undefined) ?? "chat";
    const task = TaskContractSchema.parse({
      objective,
      model:
        option("--model") ?? (executionChannel === "chatgpt_web" ? "chatgpt-web.auto" : "auto"),
      effort: option("--effort") ?? "medium",
      taskKind: option("--kind") ?? "general",
      permissions: option("--permission") ? { preset: option("--permission") } : undefined,
      sessionKey: option("--session-key"),
      sessionMode:
        executionChannel === "chatgpt_web"
          ? "ephemeral"
          : ((option("--session") as "ephemeral" | "persistent" | undefined) ??
            (option("--session-key") ? "persistent" : "ephemeral")),
      executionChannel,
      chatgptWeb:
        executionChannel === "chatgpt_web"
          ? {
              mode: chatgptMode,
              conversationMode: "temporary_per_request",
              temporaryChat: true,
              personalized: false,
              requireSources: process.argv.includes("--require-sources"),
            }
          : undefined,
      deadlineMs:
        executionChannel === "chatgpt_web"
          ? chatgptMode === "deep_research"
            ? 3_600_000
            : 600_000
          : undefined,
      budget:
        executionChannel === "chatgpt_web" ? { maxOutputTokens: 8_192, maxAttempts: 1 } : undefined,
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
  } else if (command === "research") {
    const objective = option("--task");
    if (!objective) throw new Error("research requires --task");
    const mode = (option("--mode") as "chat" | "search" | "deep_research" | undefined) ?? "search";
    const task = TaskContractSchema.parse({
      objective,
      model: option("--model") ?? "chatgpt-web.auto",
      executionChannel: "chatgpt_web",
      chatgptWeb: {
        mode,
        conversationMode: "temporary_per_request",
        temporaryChat: true,
        personalized: false,
        requireSources: true,
      },
      sessionMode: "ephemeral",
      permissions: { preset: "restricted" },
      deadlineMs: mode === "deep_research" ? 3_600_000 : 600_000,
      budget: { maxOutputTokens: 8_192, maxAttempts: 1 },
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
  } else if (command === "chat") {
    const message = option("--message");
    if (!message) {
      throw new Error("chat requires --message");
    }
    const completion = await router?.createChatCompletion({
      model: option("--model") ?? "auto",
      messages: [{ role: "user", content: message }],
      reasoning_effort: (option("--effort") as ReasoningEffort | undefined) ?? undefined,
      aialra: {
        session_key: option("--session-key"),
        session_mode:
          (option("--session") as "ephemeral" | "persistent" | undefined) ??
          (option("--session-key") ? "persistent" : undefined),
        permission_preset: (option("--permission") as PermissionPreset | undefined) ?? undefined,
      },
    });
    print(completion);
  } else if (command === "threads") {
    print(await router?.listSessionThreads(Number(option("--limit") ?? 100)));
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
      "AIALRA Model Router CLI\n\nCommands: call, research, chat, batch, jobs, threads, cancel, eval, quota\n\nUse research --task <text> --mode search|deep_research for the experimental ChatGPT web channel. Use --permission restricted|confirm|full with Codex call or chat. The call and research commands wait for a terminal result by default. Add --async to return after admission. Use --session persistent to start a resumable Codex conversation and --session-key <thread> to continue it.\n",
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
