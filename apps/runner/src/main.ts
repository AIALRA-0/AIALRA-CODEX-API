import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ModelCatalogSnapshot, QuotaSnapshot } from "@aialra/contracts";
import { RouteDecisionSchema, TaskContractSchema } from "@aialra/contracts";
import {
  cleanupExpiredCodexSessions,
  CodexAppServerClient,
  CodexProvider,
} from "@aialra/providers";
import { z } from "zod";

import { codexEnvironment } from "./environment.js";
import { runnerPublicMessage } from "./public-error.js";

const InvocationSchema = z
  .object({
    jobId: z.string().uuid(),
    task: TaskContractSchema,
    route: RouteDecisionSchema,
  })
  .strict();

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const runnerApiToken = readRequiredSecret("RUNNER_API_TOKEN");
const maxConcurrency = Math.max(1, Number(process.env.RUNNER_MAX_CONCURRENCY ?? 1));
let activeInvocations = 0;
let currentQuota: QuotaSnapshot | null = null;
let currentModels: ModelCatalogSnapshot | null = null;

function readRequiredSecret(name: string): string {
  const secretPath = process.env[`${name}_FILE`];
  const value = secretPath && existsSync(secretPath) ? readFileSync(secretPath, "utf8").trim() : "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isAuthorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(runnerApiToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
const appServer = new CodexAppServerClient({
  codexPath: process.env.CODEX_BIN || undefined,
  environment: codexEnvironment(),
  onQuota: (snapshot) => {
    currentQuota = snapshot;
  },
});

async function refreshRuntimeState(): Promise<void> {
  const [quotaResult, modelResult] = await Promise.allSettled([
    appServer.readQuota(),
    appServer.listModels(),
  ]);
  if (quotaResult.status === "fulfilled") currentQuota = quotaResult.value;
  if (modelResult.status === "fulfilled") currentModels = modelResult.value;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("runner_request_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeLine(response: ServerResponse, value: unknown): void {
  response.write(`${JSON.stringify(value)}\n`);
}

async function invoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (activeInvocations >= maxConcurrency) {
    response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
    response.end(JSON.stringify({ error: { code: "runner_busy" } }));
    return;
  }
  activeInvocations += 1;
  const abortController = new AbortController();
  request.once("aborted", () => abortController.abort());
  let workspace: string | null = null;
  try {
    const input = InvocationSchema.parse(await readJson(request));
    workspace = await mkdtemp(join("/workspace/jobs", `${input.jobId}-`));
    response.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const provider = new CodexProvider({
      codexPathOverride: process.env.CODEX_BIN || undefined,
      authDirectory: process.env.CODEX_HOME,
      environment: codexEnvironment(),
    });
    const result = await provider.invoke({
      jobId: input.jobId,
      task: input.task,
      route: input.route,
      workingDirectory: workspace,
      signal: abortController.signal,
      onEvent: (event) => writeLine(response, { type: "event", event }),
    });
    writeLine(response, { type: "result", result });
    response.end();
  } catch {
    if (!response.headersSent) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { code: "runner_rejected", message: runnerPublicMessage("request") },
        }),
      );
    } else {
      writeLine(response, {
        type: "error",
        error: { code: "runner_failed", message: runnerPublicMessage("execution") },
      });
      response.end();
    }
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
    activeInvocations -= 1;
  }
}

async function quota(response: ServerResponse): Promise<void> {
  try {
    if (!currentQuota) await refreshRuntimeState();
    if (!currentQuota) throw new Error("quota_unavailable");
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(currentQuota));
  } catch {
    response.writeHead(503, { "content-type": "application/json", "retry-after": "5" });
    response.end(
      JSON.stringify({
        error: {
          code: "quota_unavailable",
          message: runnerPublicMessage("quota"),
        },
      }),
    );
  }
}

async function models(response: ServerResponse): Promise<void> {
  try {
    if (!currentModels) await refreshRuntimeState();
    if (!currentModels) throw new Error("model_catalog_unavailable");
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(currentModels));
  } catch {
    response.writeHead(503, { "content-type": "application/json", "retry-after": "5" });
    response.end(
      JSON.stringify({
        error: {
          code: "model_catalog_unavailable",
          message: runnerPublicMessage("models"),
        },
      }),
    );
  }
}

const port = Number(process.env.RUNNER_PORT ?? 13214);
const sessionTtlMs = Math.max(60_000, Number(process.env.CODEX_SESSION_TTL_MS ?? 86_400_000));
const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "aialra-model-router-runner" }));
    return;
  }
  if (!isAuthorized(request)) {
    response.writeHead(401, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ error: { code: "runner_unauthorized" } }));
    return;
  }
  if (request.method === "GET" && request.url === "/quota") {
    void quota(response);
    return;
  }
  if (request.method === "GET" && request.url === "/models") {
    void models(response);
    return;
  }
  if (request.method === "POST" && request.url === "/invoke") {
    void invoke(request, response);
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code: "not_found" } }));
});

server.listen(port, "0.0.0.0");

void refreshRuntimeState();
const runtimeRefreshTimer = setInterval(() => void refreshRuntimeState(), 30_000);
runtimeRefreshTimer.unref();

const reapExpiredSessions = () =>
  void cleanupExpiredCodexSessions(codexHome, sessionTtlMs).catch(() => undefined);
reapExpiredSessions();
const sessionReaperTimer = setInterval(reapExpiredSessions, 3_600_000);
sessionReaperTimer.unref();

const shutdown = () => {
  clearInterval(runtimeRefreshTimer);
  clearInterval(sessionReaperTimer);
  appServer.close();
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
