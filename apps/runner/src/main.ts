import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

import { RouteDecisionSchema, TaskContractSchema } from "@aialra/contracts";
import { CodexProvider, CodexQuotaClient } from "@aialra/providers";
import { redact } from "@aialra/security";
import { z } from "zod";

import { codexEnvironment } from "./environment.js";

const InvocationSchema = z
  .object({
    jobId: z.string().uuid(),
    task: TaskContractSchema,
    route: RouteDecisionSchema,
  })
  .strict();

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const maxConcurrency = Math.max(1, Number(process.env.RUNNER_MAX_CONCURRENCY ?? 1));
let activeInvocations = 0;

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
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "runner_rejected", message } }));
    } else {
      writeLine(response, { type: "error", error: { code: "runner_failed", message } });
      response.end();
    }
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
    activeInvocations -= 1;
  }
}

async function quota(response: ServerResponse): Promise<void> {
  try {
    const snapshot = await new CodexQuotaClient({
      codexPath: process.env.CODEX_BIN || undefined,
    }).read();
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(snapshot));
  } catch (error) {
    response.writeHead(503, { "content-type": "application/json", "retry-after": "5" });
    response.end(
      JSON.stringify({
        error: {
          code: "quota_unavailable",
          message: redact(error instanceof Error ? error.message : String(error)),
        },
      }),
    );
  }
}

const port = Number(process.env.RUNNER_PORT ?? 13214);
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "aialra-model-router-runner" }));
    return;
  }
  if (request.method === "GET" && request.url === "/quota") {
    void quota(response);
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

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
