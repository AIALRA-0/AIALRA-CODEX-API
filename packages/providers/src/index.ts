import { spawn } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { Codex, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";

import type {
  ModelCatalogSnapshot,
  QuotaSnapshot,
  ReasoningEffort,
  RouteDecision,
  TaskContract,
  UsageLedger,
} from "@aialra/contracts";
import { redact } from "@aialra/security";

export interface ProviderEvent {
  type: "output.delta" | "tool" | "usage";
  data: Record<string, unknown>;
}

export interface ProviderInvocation {
  jobId?: string;
  attempt?: number;
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
  sources?: string[];
  conversationUrl?: string | null;
}

export interface ModelProvider {
  readonly name: "codex" | "chatgpt_web";
  readonly workspaceMode?: "caller" | "provider";
  invoke(invocation: ProviderInvocation): Promise<ProviderResult>;
}

export interface CodexProviderOptions {
  codexPathOverride?: string;
  environment?: Record<string, string>;
  authDirectory?: string;
}

export function codexThreadPermissionOptions(preset: "restricted" | "confirm" | "full"): {
  sandboxMode: "read-only" | "workspace-write";
  networkAccessEnabled: boolean;
  webSearchMode: "disabled" | "live";
  approvalPolicy: "never";
} {
  const networkAccessEnabled = preset === "confirm" || preset === "full";
  return {
    sandboxMode: preset === "restricted" ? "read-only" : "workspace-write",
    networkAccessEnabled,
    webSearchMode: networkAccessEnabled ? "live" : "disabled",
    approvalPolicy: "never",
  };
}

export const CODEX_CREDIT_RATE_CARD = {
  effectiveDate: "2026-08-25",
  source: "https://learn.chatgpt.com/docs/pricing",
  models: {
    "gpt-5.6-luna": { input: 5, cachedInput: 0.5, output: 30 },
    "gpt-5.6-terra": { input: 50, cachedInput: 5, output: 300 },
    "gpt-5.6-sol": { input: 100, cachedInput: 10, output: 500 },
    "gpt-5.5": { input: 125, cachedInput: 12.5, output: 750 },
    "gpt-5.4": { input: 62.5, cachedInput: 6.25, output: 375 },
    "gpt-5.4-mini": { input: 18.75, cachedInput: 1.875, output: 113 },
  },
} as const;

export const CODEX_API_USD_RATE_CARD = {
  effectiveDate: "2026-08-27",
  source: "https://developers.openai.com/api/docs/models/compare",
  models: {
    "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
    "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
    "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
    "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
    "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
    "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  },
} as const;

export function buildTaskPrompt(task: TaskContract): string {
  const contract = {
    objective: task.objective,
    required_context: task.requiredContext,
    constraints: task.constraints,
    expected_output: task.expectedOutput,
    validation_checks: task.validation.checks,
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
    const permissionPreset = task.permissions.preset ?? "restricted";
    const runtimePermissions = codexThreadPermissionOptions(permissionPreset);
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
      permissionPreset === "restricted" ? "read" : "write",
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
      ...runtimePermissions,
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
      measurementStatus: "measured",
      subscriptionChannel: "codex",
      sourceCount: null,
      durationMs: null,
    };
    await invocation.onEvent?.({ type: "usage", data: usage });
    const persistSession =
      task.sessionMode === "persistent" ||
      Boolean(task.sessionKey) ||
      process.env.CODEX_PERSIST_SESSIONS === "true";
    const result = {
      output: parseStructuredOutput(outputText, task),
      outputText,
      threadId,
      usage,
    };
    if (threadId && !persistSession) {
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

export async function cleanupExpiredCodexSessions(
  authDirectory: string,
  ttlMs: number,
  now: Date = new Date(),
): Promise<number> {
  const sessionRoot = resolve(authDirectory, "sessions");
  const separator = process.platform === "win32" ? "\\" : "/";
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
      if (!target.startsWith(`${sessionRoot}${separator}`)) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const fileStat = await stat(target).catch(() => null);
        if (fileStat && now.getTime() - fileStat.mtimeMs > ttlMs) {
          await rm(target, { force: true });
          removed += 1;
        }
      }
    }
  }
  await visit(sessionRoot);
  return removed;
}

interface JsonRpcResponse {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface RateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

function quotaWindows(result: unknown) {
  const value = (result ?? {}) as {
    rateLimits?: { primary?: RateLimitWindow | null; secondary?: RateLimitWindow | null } | null;
    rateLimitsByLimitId?: Record<
      string,
      {
        limitName?: string | null;
        primary?: RateLimitWindow | null;
        secondary?: RateLimitWindow | null;
      }
    > | null;
    primary?: RateLimitWindow | null;
    secondary?: RateLimitWindow | null;
  };
  const groups = new Map<string, { name: string; limits: typeof value.rateLimits }>();
  groups.set("codex", { name: "Codex", limits: value.rateLimits ?? value });
  for (const [id, entry] of Object.entries(value.rateLimitsByLimitId ?? {})) {
    groups.set(id, { name: entry.limitName || id, limits: entry });
  }
  return [...groups.entries()].flatMap(([id, group]) =>
    (["primary", "secondary"] as const).flatMap((kind) => {
      const window = group.limits?.[kind];
      if (!window) return [];
      const usedPercent = window.usedPercent ?? null;
      return [
        {
          id: `${id}:${kind}`,
          name: group.name,
          kind,
          usedPercent,
          remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
          windowDurationMinutes: window.windowDurationMins ?? null,
          resetsAt: window.resetsAt ? new Date(window.resetsAt * 1_000).toISOString() : null,
        },
      ];
    }),
  );
}

export function quotaSnapshotFromAppServer(result: unknown): QuotaSnapshot {
  const value = (result ?? {}) as { planType?: string | null };
  const windows = quotaWindows(result);
  const primary = windows.find((window) => window.id === "codex:primary") ?? windows[0] ?? null;
  return {
    provider: "codex",
    usedPercent: primary?.usedPercent ?? null,
    windowDurationMinutes: primary?.windowDurationMinutes ?? null,
    resetsAt: primary?.resetsAt ?? null,
    planType: value.planType ?? null,
    fetchedAt: new Date().toISOString(),
    source: "app-server",
    windows,
    stale: false,
  };
}

const KNOWN_REASONING_EFFORTS = new Set<ReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function modelCatalogFromAppServer(result: unknown): ModelCatalogSnapshot {
  const value = (result ?? {}) as { data?: unknown[]; models?: unknown[] };
  const rows = value.data ?? value.models ?? (Array.isArray(result) ? result : []);
  const discoveredAt = new Date().toISOString();
  return {
    fetchedAt: discoveredAt,
    source: "app-server",
    models: rows.flatMap((row) => {
      const item = row as Record<string, unknown>;
      const id = String(item.id ?? item.model ?? item.slug ?? "").trim();
      if (!id) return [];
      const rawEfforts = (item.supportedReasoningEfforts ??
        item.supported_reasoning_efforts ??
        []) as unknown[];
      const supportedReasoningEfforts = rawEfforts
        .map((effort) => {
          if (typeof effort === "string") return effort;
          if (effort && typeof effort === "object") {
            const option = effort as Record<string, unknown>;
            return String(option.reasoningEffort ?? option.reasoning_effort ?? "");
          }
          return "";
        })
        .filter((effort): effort is ReasoningEffort =>
          KNOWN_REASONING_EFFORTS.has(effort as ReasoningEffort),
        );
      const rawDefault = String(item.defaultReasoningEffort ?? item.default_reasoning_effort ?? "");
      const defaultReasoningEffort = KNOWN_REASONING_EFFORTS.has(rawDefault as ReasoningEffort)
        ? (rawDefault as ReasoningEffort)
        : null;
      return [
        {
          id,
          displayName: String(item.displayName ?? item.display_name ?? item.name ?? id),
          provider: "codex" as const,
          available: true,
          hidden: Boolean(item.hidden),
          isDefault: Boolean(item.isDefault ?? item.is_default),
          supportedReasoningEfforts,
          defaultReasoningEffort,
          inputModalities: (
            (item.inputModalities ?? item.input_modalities ?? ["text"]) as unknown[]
          ).map(String),
          creditRate: null,
          apiRate: null,
          rateStatus: "unavailable" as const,
          streamingMode: "delta" as const,
          discoveredAt,
        },
      ];
    }),
  };
}

export interface CodexAppServerClientOptions {
  codexPath?: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  onQuota?: (snapshot: QuotaSnapshot) => void;
}

export class CodexAppServerClient {
  private child: ReturnType<typeof spawn> | null = null;
  private lines: ReturnType<typeof createInterface> | null = null;
  private requestId = 1;
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >();

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  private async start(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const child = spawn(this.options.codexPath ?? "codex", ["app-server"], {
        env: this.options.environment ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      this.lines = createInterface({ input: child.stdout });
      this.lines.on("line", (line) => this.handleLine(line));
      child.once("exit", () => this.reset(new Error("codex_app_server_exited")));
      child.once("error", (error) => this.reset(error));
      await this.send("initialize", {
        clientInfo: { name: "aialra-model-router", title: "AIALRA Model Router", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      await this.send("initialized", undefined, true);
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as JsonRpcResponse;
      if (message.method === "account/rateLimits/updated") {
        this.options.onQuota?.(quotaSnapshotFromAppServer(message.params));
        return;
      }
      if (message.id === undefined) return;
      const handler = this.pending.get(message.id);
      if (!handler) return;
      clearTimeout(handler.timeout);
      this.pending.delete(message.id);
      if (message.error)
        handler.reject(new Error(redact(message.error.message ?? "app_server_error")));
      else handler.resolve(message.result);
    } catch {
      // App Server can emit non-protocol notices. They never become application data.
    }
  }

  private reset(error: Error): void {
    this.lines?.close();
    this.lines = null;
    this.child = null;
    for (const handler of this.pending.values()) {
      clearTimeout(handler.timeout);
      handler.reject(error);
    }
    this.pending.clear();
  }

  private async send(method: string, params?: unknown, notification = false): Promise<unknown> {
    if (method !== "initialize" && !this.child) await this.start();
    const child = this.child;
    const stdin = child?.stdin;
    if (!stdin?.writable) throw new Error("codex_app_server_unavailable");
    if (notification) {
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      return null;
    }
    const id = this.requestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("codex_app_server_timeout"));
      }, this.options.timeoutMs ?? 10_000);
      this.pending.set(id, { resolve, reject, timeout });
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  async readQuota(): Promise<QuotaSnapshot> {
    await this.start();
    return quotaSnapshotFromAppServer(await this.send("account/rateLimits/read"));
  }

  async listModels(): Promise<ModelCatalogSnapshot> {
    await this.start();
    return modelCatalogFromAppServer(await this.send("model/list", { limit: 100 }));
  }

  close(): void {
    const child = this.child;
    this.reset(new Error("codex_app_server_closed"));
    child?.kill();
  }
}

export class CodexQuotaClient {
  private readonly client: CodexAppServerClient;
  constructor(options: CodexAppServerClientOptions = {}) {
    this.client = new CodexAppServerClient(options);
  }
  async read(): Promise<QuotaSnapshot> {
    try {
      return await this.client.readQuota();
    } finally {
      this.client.close();
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
    windows: [],
    stale: true,
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
