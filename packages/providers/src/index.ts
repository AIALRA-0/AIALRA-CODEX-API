import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { Codex, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";

import type { QuotaSnapshot, RouteDecision, TaskContract, UsageLedger } from "@aialra/contracts";
import { redact } from "@aialra/security";

export interface ProviderEvent {
  type: "output.delta" | "tool" | "usage";
  data: Record<string, unknown>;
}

export interface ProviderInvocation {
  jobId?: string;
  task: TaskContract;
  route: RouteDecision;
  workingDirectory?: string;
  signal?: AbortSignal;
  onEvent?: (event: ProviderEvent) => Promise<void> | void;
}

export interface ProviderResult {
  output: unknown;
  outputText: string;
  threadId: string | null;
  usage: UsageLedger;
}

export interface ModelProvider {
  readonly name: "codex";
  readonly workspaceMode?: "caller" | "provider";
  invoke(invocation: ProviderInvocation): Promise<ProviderResult>;
}

export interface CodexProviderOptions {
  codexPathOverride?: string;
  environment?: Record<string, string>;
  authDirectory?: string;
}

export const CODEX_CREDIT_RATE_CARD = {
  effectiveDate: "2026-08-25",
  source: "https://learn.chatgpt.com/docs/pricing",
  models: {
    "gpt-5.6-luna": { input: 5, cachedInput: 0.5, output: 30 },
    "gpt-5.6-terra": { input: 50, cachedInput: 5, output: 300 },
    "gpt-5.6-sol": { input: 100, cachedInput: 10, output: 500 },
  },
} as const;

export const CODEX_API_USD_RATE_CARD = {
  effectiveDate: "2026-08-27",
  source: "https://developers.openai.com/api/docs/models/compare",
  models: {
    "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
    "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
    "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
  },
} as const;

export function buildTaskPrompt(task: TaskContract): string {
  const contract = {
    objective: task.objective,
    required_context: task.requiredContext,
    constraints: task.constraints,
    expected_output: task.expectedOutput,
    acceptance_tests: task.validation.acceptanceTests,
    permissions: task.permissions,
  };

  return [
    "Complete the following task contract and return only the final deliverable.",
    "Do not delegate this task to another agent.",
    JSON.stringify(contract, null, 2),
  ].join("\n\n");
}

export function calculateCodexCredits(
  model: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number | null {
  const rate = CODEX_CREDIT_RATE_CARD.models[model as keyof typeof CODEX_CREDIT_RATE_CARD.models];
  if (!rate) {
    return null;
  }

  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (uncachedInputTokens * rate.input +
      cachedInputTokens * rate.cachedInput +
      outputTokens * rate.output) /
    1_000_000
  );
}

export function calculateApiEquivalentUsd(
  model: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number | null {
  const rate = CODEX_API_USD_RATE_CARD.models[model as keyof typeof CODEX_API_USD_RATE_CARD.models];
  if (!rate) {
    return null;
  }

  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (uncachedInputTokens * rate.input +
      cachedInputTokens * rate.cachedInput +
      outputTokens * rate.output) /
    1_000_000
  );
}

function parseStructuredOutput(text: string, task: TaskContract): unknown {
  if (!task.validation.responseSchema) {
    return text;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toolEvent(item: ThreadItem): ProviderEvent | null {
  if (item.type === "command_execution") {
    return {
      type: "tool",
      data: {
        kind: item.type,
        id: item.id,
        command: redact(item.command),
        status: item.status,
        exitCode: item.exit_code,
      },
    };
  }
  if (item.type === "file_change") {
    return {
      type: "tool",
      data: { kind: item.type, id: item.id, changes: item.changes, status: item.status },
    };
  }
  if (item.type === "mcp_tool_call") {
    return {
      type: "tool",
      data: {
        kind: item.type,
        id: item.id,
        server: item.server,
        tool: item.tool,
        status: item.status,
      },
    };
  }
  if (item.type === "web_search") {
    return { type: "tool", data: { kind: item.type, id: item.id, query: item.query } };
  }
  return null;
}

export class CodexProvider implements ModelProvider {
  readonly name = "codex" as const;
  readonly workspaceMode = "caller" as const;
  private readonly options: CodexProviderOptions;

  constructor(options: CodexProviderOptions = {}) {
    this.options = options;
  }

  async invoke(invocation: ProviderInvocation): Promise<ProviderResult> {
    const { task, route } = invocation;
    if (task.permissions.network !== "none") {
      throw new Error("network_allowlist_not_enforced");
    }
    const authDirectory = resolve(
      this.options.authDirectory ??
        this.options.environment?.CODEX_HOME ??
        process.env.CODEX_HOME ??
        join(homedir(), ".codex"),
    );
    const workingDirectory = resolve(invocation.workingDirectory ?? process.cwd());
    const filesystemOverride = codexFilesystemPermissionOverride(
      authDirectory,
      workingDirectory,
      task.permissions.filesystem,
    );
    const codex = new Codex({
      codexPathOverride: this.options.codexPathOverride,
      env: this.options.environment,
      config: { default_permissions: "aialra_router_task" },
      configOverrides: [filesystemOverride],
    });
    const threadOptions = {
      model: route.model,
      workingDirectory,
      skipGitRepoCheck: true,
      modelReasoningEffort: route.effort,
      networkAccessEnabled: false,
      webSearchMode: "disabled" as const,
      approvalPolicy: "never" as const,
      threadSource: "aialra-model-router",
    } as const;
    const thread = task.sessionKey
      ? codex.resumeThread(task.sessionKey, threadOptions)
      : codex.startThread(threadOptions);
    const streamed = await thread.runStreamed(buildTaskPrompt(task), {
      outputSchema: task.validation.responseSchema,
      signal: invocation.signal,
    });

    let outputText = "";
    let threadId: string | null = thread.id;
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    let streamedText = "";

    for await (const event of streamed.events) {
      if (event.type === "thread.started") {
        threadId = event.thread_id;
      } else if (event.type === "item.updated" || event.type === "item.completed") {
        if (event.item.type === "agent_message") {
          outputText = event.item.text;
          const delta = event.item.text.startsWith(streamedText)
            ? event.item.text.slice(streamedText.length)
            : event.item.text;
          if (delta) {
            streamedText = event.item.text;
            await invocation.onEvent?.({ type: "output.delta", data: { delta } });
          }
        }
        if (event.type === "item.completed") {
          const emittedTool = toolEvent(event.item);
          if (emittedTool) {
            await invocation.onEvent?.(emittedTool);
          }
        }
      } else if (event.type === "turn.completed") {
        inputTokens = event.usage.input_tokens;
        cachedInputTokens = event.usage.cached_input_tokens;
        outputTokens = event.usage.output_tokens;
      } else if (event.type === "turn.failed") {
        throw new Error(redact(event.error.message));
      } else if (event.type === "error") {
        throw new Error(redact(event.message));
      }
    }

    const usage: UsageLedger = {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      codexCredits: calculateCodexCredits(
        route.model,
        inputTokens,
        cachedInputTokens,
        outputTokens,
      ),
      apiEquivalentUsd: calculateApiEquivalentUsd(
        route.model,
        inputTokens,
        cachedInputTokens,
        outputTokens,
      ),
      quotaUsedPercentBefore: null,
      quotaUsedPercentAfter: null,
      quotaWindowDeltaPercent: null,
      allocatedSubscriptionUsd: null,
    };
    await invocation.onEvent?.({ type: "usage", data: usage });
    const result = {
      output: parseStructuredOutput(outputText, task),
      outputText,
      threadId,
      usage,
    };
    if (threadId && process.env.CODEX_PERSIST_SESSIONS !== "true") {
      await removeCodexSession(authDirectory, threadId);
      result.threadId = null;
    }
    return result;
  }
}

function tomlKey(value: string): string {
  return `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
}

export function codexFilesystemPermissionOverride(
  authDirectory: string,
  workingDirectory: string,
  permission: "none" | "read" | "write",
): string {
  const rules = [
    // The immutable Runner image must remain readable so the sandbox can launch
    // its own runtime. Task workspaces and every credential-bearing mount are
    // governed by more-specific rules below.
    '":root"="read"',
    `${tomlKey(resolve("/run/secrets"))}="deny"`,
    `${tomlKey(resolve("/proc"))}="deny"`,
    `${tomlKey(resolve(authDirectory))}="deny"`,
  ];
  if (permission !== "none") {
    rules.push(`${tomlKey(resolve(workingDirectory))}="${permission}"`);
  }
  return `permissions.aialra_router_task.filesystem={${rules.join(",")}}`;
}

export async function removeCodexSession(authDirectory: string, threadId: string): Promise<number> {
  const sessionRoot = resolve(authDirectory, "sessions");
  let removed = 0;
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = resolve(directory, entry.name);
      if (!target.startsWith(`${sessionRoot}${process.platform === "win32" ? "\\" : "/"}`)) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile() && entry.name.includes(threadId)) {
        await rm(target, { force: true });
        removed += 1;
      }
    }
  }
  await visit(sessionRoot);
  return removed;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface RateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export function quotaSnapshotFromAppServer(result: unknown): QuotaSnapshot {
  const value = (result ?? {}) as {
    rateLimits?: {
      primary?: RateLimitWindow | null;
      secondary?: RateLimitWindow | null;
    } | null;
    primary?: RateLimitWindow | null;
    secondary?: RateLimitWindow | null;
    planType?: string | null;
  };
  const limits = value.rateLimits ?? value;
  const window = limits.primary ?? limits.secondary ?? null;
  return {
    provider: "codex",
    usedPercent: window?.usedPercent ?? null,
    windowDurationMinutes: window?.windowDurationMins ?? null,
    resetsAt: window?.resetsAt ? new Date(window.resetsAt * 1_000).toISOString() : null,
    planType: value.planType ?? null,
    fetchedAt: new Date().toISOString(),
    source: "app-server",
  };
}

export interface CodexQuotaClientOptions {
  codexPath?: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}

export class CodexQuotaClient {
  constructor(private readonly options: CodexQuotaClientOptions = {}) {}

  async read(): Promise<QuotaSnapshot> {
    const child = spawn(this.options.codexPath ?? "codex", ["app-server"], {
      env: this.options.environment ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    let requestId = 1;
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();

    const send = (method: string, params?: unknown, notification = false): Promise<unknown> => {
      if (notification) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
        return Promise.resolve(null);
      }
      const id = requestId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    };

    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as JsonRpcResponse;
        if (message.id === undefined) {
          return;
        }
        const handler = pending.get(message.id);
        if (!handler) {
          return;
        }
        pending.delete(message.id);
        if (message.error) {
          handler.reject(new Error(redact(message.error.message ?? "app_server_error")));
        } else {
          handler.resolve(message.result);
        }
      } catch {
        // Ignore non-protocol output because stderr/stdout can include upgrade notices.
      }
    });

    const timeout = setTimeout(() => {
      for (const handler of pending.values()) {
        handler.reject(new Error("codex_quota_timeout"));
      }
      pending.clear();
      child.kill();
    }, timeoutMs);

    try {
      await send("initialize", {
        clientInfo: {
          name: "aialra-model-router",
          title: "AIALRA Model Router",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      await send("initialized", undefined, true);
      const result = await send("account/rateLimits/read");
      return quotaSnapshotFromAppServer(result);
    } finally {
      clearTimeout(timeout);
      lines.close();
      child.kill();
    }
  }
}

export function unavailableQuotaSnapshot(): QuotaSnapshot {
  return {
    provider: "codex",
    usedPercent: null,
    windowDurationMinutes: null,
    resetsAt: null,
    planType: null,
    fetchedAt: new Date().toISOString(),
    source: "unavailable",
  };
}

export function isTransientProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(429|capacity|temporar|timeout|ECONNRESET|ETIMEDOUT|network)/i.test(message);
}

export function eventItem(event: ThreadEvent): ThreadItem | null {
  return event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
    ? event.item
    : null;
}
