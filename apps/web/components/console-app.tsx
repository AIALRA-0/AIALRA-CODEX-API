"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EvaluationMethods } from "./evaluation-methods";
import { Formula } from "./formula";
import { getJobResultSummary, type JobValidation } from "../lib/job-review";
import { getRemainingPercent } from "../lib/quota-display";
import { threadExpiryLabel, truncateSessionKey } from "../lib/thread-display";

type JobStatus =
  | "accepted"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "validating"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

interface Job {
  id: string;
  status: JobStatus;
  task: {
    objective: string;
    model: string;
    effort: string;
    taskKind: string;
    sessionKey?: string;
    sessionMode?: "ephemeral" | "persistent";
    executionChannel?: "codex" | "chatgpt_web";
    chatgptWeb?: {
      mode: "chat" | "search" | "deep_research";
      temporaryChat: boolean;
      requireSources: boolean;
    };
    permissions?: { preset?: "restricted" | "confirm" | "full" };
  };
  route: { provider: "codex" | "chatgpt_web"; model: string; reasonCode: string } | null;
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  validation: JobValidation | null;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    codexCredits: number | null;
    apiEquivalentUsd: number | null;
    quotaUsedPercentBefore: number | null;
    quotaUsedPercentAfter: number | null;
    quotaWindowDeltaPercent: number | null;
    allocatedSubscriptionUsd: number | null;
    measurementStatus?: "measured" | "unavailable";
    subscriptionChannel?: "codex" | "chatgpt_pro_web";
    sourceCount?: number | null;
    durationMs?: number | null;
    attemptCount?: number;
    retryCount?: number;
  };
  createdAt: string;
  updatedAt: string;
}

interface JobEventRecord {
  sequence: number;
  type: string;
  data: Record<string, unknown>;
}

interface Quota {
  usedPercent: number | null;
  windowDurationMinutes: number | null;
  resetsAt: string | null;
  planType: string | null;
  source: "app-server" | "unavailable";
  fetchedAt: string;
  stale: boolean;
  windows: Array<{
    id: string;
    name: string;
    kind: "primary" | "secondary";
    usedPercent: number | null;
    remainingPercent: number | null;
    windowDurationMinutes: number | null;
    resetsAt: string | null;
  }>;
}

interface ModelRecord {
  id: string;
  displayName: string;
  provider?: "codex" | "chatgpt_web";
  available: boolean;
  enabled: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  inputModalities: string[];
  rateStatus: "available" | "unavailable";
  creditRate: { input: number; cachedInput: number; output: number } | null;
  apiRate: { input: number; cachedInput: number; output: number } | null;
  streamingMode?: "delta" | "final_only";
}

interface ChatGptWebStatus {
  configuredEnabled: boolean;
  effectiveConcurrency: number;
  maximumConcurrency: number;
  activeTabs: number;
  queuedJobs: number;
  sandboxVerified: boolean;
  extensionConnected: boolean;
  pageReady: boolean;
  authenticated: boolean;
  circuitState: "closed" | "cooldown" | "open" | "qualification_required";
  circuitReason: string | null;
  cooldownUntil: string | null;
  rateLimitState: "clear" | "cooldown" | "recovery_probe" | "observation";
  retryAfter: number | null;
  lastRateLimitAt: string | null;
  consecutiveRateLimits: number;
  conversationMode: "temporary_per_request";
  temporaryChatVerified: boolean;
  lastRecoveryProbeAt: string | null;
  lastRecoveryProbePassed: boolean | null;
  lastSubmissionAt: string | null;
  lastQualifiedAt: string | null;
  lastQualificationPassed: boolean | null;
  adapterVersion: string;
  phase:
    | "idle"
    | "preparing"
    | "input_verified"
    | "submitted"
    | "generating"
    | "completed"
    | "failed"
    | "resetting";
  activeJobId: string | null;
  activeAttempt: number | null;
  lastHeartbeatAt: string | null;
  lastFailureCode: string | null;
  lastResetAt: string | null;
  quarantinedTabs: number;
  slots: Array<{
    slotId: string;
    state:
      | "starting"
      | "idle"
      | "preparing"
      | "ready"
      | "submitted"
      | "generating"
      | "completed"
      | "quarantined";
    submitted: boolean;
    quarantinedUntil: string | null;
    updatedAt: string;
  }>;
  lastQualificationRunId: string | null;
  updatedAt: string;
}

type ChatGptWebQualificationSuite =
  "readiness" | "single_probe" | "chat_3" | "chat_10" | "deep_2" | "full_10";

interface ChatGptWebQualificationRun {
  id: string;
  suite: ChatGptWebQualificationSuite;
  status: "accepted" | "running" | "succeeded" | "failed" | "cancelled";
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  items: Array<{
    index: number;
    name: string;
    mode: "chat" | "search" | "deep_research";
    status: "pending" | "running" | "succeeded" | "failed";
    durationMs: number | null;
    outputLength: number | null;
    sourceCount: number | null;
    errorCode: string | null;
    submittedCount: number;
    recoveryCount: number;
    ownershipMatched: boolean | null;
    temporaryChatVerified: boolean;
  }>;
}

interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  rateLimitPerMinute: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  key?: string;
  executionPolicy: {
    defaultPreset: "restricted" | "confirm" | "full";
    allowedPresets: Array<"restricted" | "confirm" | "full">;
  };
}

interface AuditRecord {
  id: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
}

interface DeletionReceipt {
  id: string;
  resourceType: string;
  resourceId: string;
  deletedAt: string;
}

interface SessionThread {
  sessionKey: string;
  callerId: string;
  model: string;
  effort: string;
  turnCount: number;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

const TERMINAL = new Set<JobStatus>(["succeeded", "failed", "cancelled", "expired"]);

const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  accepted: "已接收",
  awaiting_approval: "等待授权",
  queued: "排队中",
  running: "执行中",
  validating: "验证中",
  succeeded: "已成功",
  failed: "已失败",
  cancelled: "已取消",
  expired: "已超时",
};

const TASK_KIND_LABEL: Record<string, string> = {
  general: "通用",
  bounded: "结构化",
  coding: "编码",
  review: "审查",
  planning: "规划",
  batch: "批处理",
};

const LEVEL_LABEL = ["很低", "低", "中", "高", "很高"] as const;

async function routerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/router${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (response.redirected) {
    throw new Error("登录状态已失效，请刷新页面后重新登录。");
  }
  const value = (await response.json().catch(() => null)) as
    T | { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    const error = value as { error?: { code?: string; message?: string } } | null;
    const failure = new Error(
      error?.error?.message ?? `请求失败 HTTP ${response.status}`,
    ) as Error & { code?: string };
    failure.code = error?.error?.code;
    throw failure;
  }
  return value as T;
}

function useVisiblePolling(refresh: (signal?: AbortSignal) => Promise<void>, intervalMs: number) {
  useEffect(() => {
    let controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
      controller.abort();
    };
    const start = () => {
      if (timer || document.hidden) return;
      controller = new AbortController();
      void refresh(controller.signal);
      timer = setInterval(() => void refresh(controller.signal), intervalMs);
    };
    const visibility = () => {
      stop();
      if (!document.hidden) start();
    };
    start();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [intervalMs, refresh]);
}

function HelpTip({ id, children }: { id: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <span
      className="help-tip-wrap"
      ref={wrapRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        className="help-tip-button"
        aria-label="查看说明"
        aria-describedby={id}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
      >
        说明
      </button>
      <span id={id} role="tooltip" className="help-tip" data-open={open ? "true" : "false"}>
        {children}
      </span>
    </span>
  );
}

function formatDate(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(
        new Date(value),
      )
    : "—";
}

function statusClass(status: JobStatus): string {
  if (status === "succeeded") return "success";
  if (status === "awaiting_approval") return "warning";
  if (["failed", "expired"].includes(status)) return "danger";
  return "muted";
}

function formatCredits(value: number | null): string {
  return value == null ? "—" : value.toFixed(4);
}

function formatUsd(value: number | null): string {
  if (value == null) return "—";
  return `US$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

function formatQuotaDelta(value: number | null): string {
  if (value == null) return "暂不可计算";
  if (value === 0) return "低于额度读数精度";
  return `+${value.toFixed(3)} 个百分点`;
}

function apiEquivalentUsd(job: Job): number | null {
  if (job.usage.measurementStatus === "unavailable") return null;
  if (job.usage.apiEquivalentUsd != null) return job.usage.apiEquivalentUsd;
  return job.usage.codexCredits == null ? null : job.usage.codexCredits * 0.04;
}

function perThousandTokens(job: Job): number | null {
  const total = job.usage.inputTokens + job.usage.outputTokens;
  const equivalentUsd = apiEquivalentUsd(job);
  if (!total || equivalentUsd == null) return null;
  return (equivalentUsd / total) * 1_000;
}

function ErrorNotice({ message }: { message: string }) {
  return message ? (
    <p className="error-message" role="alert">
      {message}
    </p>
  ) : null;
}

function NativeDialog({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="confirm-dialog" onClose={onClose}>
      {children}
    </dialog>
  );
}

function PageHeading({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading row">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="lead">{copy}</p>
      </div>
      {action}
    </div>
  );
}

function JobTable({ jobs, onSelect }: { jobs: Job[]; onSelect?: (job: Job) => void }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>调用</th>
            <th>状态</th>
            <th>执行通道与模型</th>
            <th>类型</th>
            <th>API 等效成本</th>
            <th>单次额度变化</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          {jobs.length === 0 ? (
            <tr>
              <td colSpan={7} className="muted">
                当前没有调用记录
              </td>
            </tr>
          ) : (
            jobs.map((job) => {
              const resultSummary = getJobResultSummary(job);
              return (
                <tr key={job.id}>
                  <td>
                    {onSelect ? (
                      <Link
                        className="table-link"
                        href={`/console/jobs?job=${encodeURIComponent(job.id)}`}
                        onNavigate={() => onSelect(job)}
                      >
                        <code>{job.id.slice(0, 8)}</code>
                        <span className="sr-only">，查看详情</span>
                      </Link>
                    ) : (
                      <Link
                        className="table-link"
                        href={`/console/jobs?job=${encodeURIComponent(job.id)}`}
                      >
                        <code>{job.id.slice(0, 8)}</code>
                        <span className="sr-only">，查看详情</span>
                      </Link>
                    )}
                  </td>
                  <td className={statusClass(job.status)}>
                    {resultSummary?.label ?? JOB_STATUS_LABEL[job.status]}
                  </td>
                  <td>
                    {job.task.executionChannel === "chatgpt_web" ? "ChatGPT 网页" : "Codex"}
                    {" · "}
                    {job.route?.model ?? job.task.model}
                  </td>
                  <td>{TASK_KIND_LABEL[job.task.taskKind] ?? job.task.taskKind}</td>
                  <td>
                    {job.usage.measurementStatus === "unavailable"
                      ? "网页未提供可靠数据"
                      : formatUsd(apiEquivalentUsd(job))}
                  </td>
                  <td>
                    {job.usage.measurementStatus === "unavailable"
                      ? "网页未提供可靠数据"
                      : formatQuotaDelta(job.usage.quotaWindowDeltaPercent)}
                  </td>
                  <td>{formatDate(job.createdAt)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function Overview() {
  const syntheticDemo = process.env.NEXT_PUBLIC_SYNTHETIC_DEMO === "true";
  const [jobs, setJobs] = useState<Job[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const [jobResult, quotaResult] = await Promise.all([
        routerFetch<{ data: Job[] }>("/api/v1/jobs?limit=12", { signal }),
        routerFetch<Quota>("/api/v1/quota", { signal }),
      ]);
      setJobs(jobResult.data);
      setQuota(quotaResult);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "控制面读取失败");
    }
  }, []);
  useVisiblePolling(refresh, 5_000);
  const active = jobs.filter((job) => !TERMINAL.has(job.status)).length;
  const succeeded = jobs.filter((job) => job.status === "succeeded").length;
  const completed = jobs.filter((job) => TERMINAL.has(job.status)).length;
  const completionRate = completed ? Math.round((succeeded / completed) * 1000) / 10 : 0;
  const primaryQuota = quota?.windows.find((window) => window.kind === "primary");
  const overviewUsedPercent = primaryQuota?.usedPercent ?? quota?.usedPercent ?? null;
  const overviewRemainingPercent = getRemainingPercent(
    primaryQuota?.remainingPercent ?? null,
    overviewUsedPercent,
  );
  return (
    <>
      {syntheticDemo ? (
        <p className="notice" role="status">
          演示模式：本页数据全部为合成数据，不连接真实账号、任务或额度。
        </p>
      ) : null}
      <PageHeading
        eyebrow="运行状态"
        title="Codex 容量总览"
        copy={
          syntheticDemo
            ? "用于公开截图的合成控制台，不连接真实运行数据"
            : "这里读取真实队列、额度周期和最近调用，不使用合成数据"
        }
        action={
          <button className="button" onClick={() => void refresh()}>
            刷新
          </button>
        }
      />
      <ErrorNotice message={error} />
      <section className="metrics" aria-label="运行指标">
        <article className="metric">
          <small>Codex 剩余额度</small>
          <strong>{overviewRemainingPercent == null ? "—" : `${overviewRemainingPercent}%`}</strong>
          <div className="progress">
            <span style={{ width: `${overviewRemainingPercent ?? 0}%` }} />
          </div>
          <span className="muted">
            {overviewUsedPercent == null ? "已使用 —" : `已使用 ${overviewUsedPercent}%`} · 来源{" "}
            {quota?.source === "app-server" ? "Codex App Server" : "暂不可用"}
            {quota?.stale ? " · 数据已过期" : ""}
          </span>
        </article>
        <article className="metric">
          <small>当前活动调用</small>
          <strong>{active}</strong>
          <span className={active ? "warning" : "success"}>
            {active ? "队列正在处理" : "队列空闲"}
          </span>
        </article>
        <article className="metric">
          <small>最近调用成功率</small>
          <strong>{completed ? `${completionRate}%` : "—"}</strong>
          <span className="muted">基于最近 {jobs.length} 次调用</span>
        </article>
      </section>
      <section className="console-section">
        <div className="row">
          <h3>最近调用</h3>
          <a className="button" href="/console/jobs">
            查看全部
          </a>
        </div>
        <JobTable jobs={jobs} />
      </section>
    </>
  );
}

function Playground() {
  const searchParams = useSearchParams();
  const [objective, setObjective] = useState("把下面内容归纳为 3 个要点，只返回结果");
  const [model, setModel] = useState("auto");
  const [executionChannel, setExecutionChannel] = useState<"codex" | "chatgpt_web">("codex");
  const [chatgptMode, setChatgptMode] = useState<"chat" | "search" | "deep_research">("search");
  const [temporaryChat] = useState(true);
  const [requireSources, setRequireSources] = useState(true);
  const [effort, setEffort] = useState("medium");
  const [taskKind, setTaskKind] = useState("general");
  const [permissionPreset, setPermissionPreset] = useState<"restricted" | "confirm" | "full">(
    "full",
  );
  const [sessionMode, setSessionMode] = useState<"ephemeral" | "persistent">("ephemeral");
  const [sessionKey, setSessionKey] = useState("");
  const [schemaText, setSchemaText] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [models, setModels] = useState<ModelRecord[]>([]);
  const chatGptWebAvailable = models.some(
    (item) => item.provider === "chatgpt_web" && item.available && item.enabled,
  );
  useEffect(() => {
    const requested = searchParams.get("session");
    if (requested) {
      setSessionKey(requested);
      setSessionMode("persistent");
    }
  }, [searchParams]);
  const refreshModels = useCallback(async (signal?: AbortSignal) => {
    const result = await routerFetch<{ data: ModelRecord[] }>("/api/v1/models", { signal });
    setModels(result.data);
  }, []);
  useVisiblePolling(refreshModels, 30_000);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const responseSchema = schemaText.trim() ? JSON.parse(schemaText) : undefined;
      const deadlineMs =
        executionChannel === "chatgpt_web"
          ? chatgptMode === "deep_research"
            ? 3_600_000
            : 600_000
          : 120_000;
      const created = await routerFetch<Job>("/api/v1/jobs", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          task: {
            objective,
            model,
            effort,
            taskKind,
            executionChannel,
            ...(executionChannel === "chatgpt_web"
              ? {
                  chatgptWeb: {
                    mode: chatgptMode,
                    conversationMode: "temporary_per_request",
                    temporaryChat,
                    personalized: false,
                    requireSources,
                  },
                }
              : {}),
            expectedOutput: responseSchema
              ? "按照指定 JSON Schema 返回"
              : "返回可直接使用的最终结果",
            validation: { responseSchema, checks: [], acceptanceTests: [] },
            permissions: {
              preset: executionChannel === "chatgpt_web" ? "restricted" : permissionPreset,
            },
            sessionMode: executionChannel === "chatgpt_web" ? "ephemeral" : sessionMode,
            ...(executionChannel === "codex" && sessionKey.trim()
              ? { sessionKey: sessionKey.trim() }
              : {}),
            deadlineMs,
            budget: {
              maxOutputTokens: 8192,
              maxAttempts: executionChannel === "chatgpt_web" ? 1 : 2,
            },
          },
          metadata: { source: "private-console" },
        }),
      });
      setJob(created);
      let current = created;
      while (!TERMINAL.has(current.status) && current.status !== "awaiting_approval") {
        await new Promise((resolve) => setTimeout(resolve, 600));
        current = await routerFetch<Job>(`/api/v1/jobs/${created.id}`);
        setJob(current);
      }
    } catch (cause) {
      const code = (cause as { code?: string } | null)?.code;
      setError(
        code === "session_expired"
          ? "无法继续这段对话：会话线程不存在或已到期。线程在创建 24 小时后会自动清除，请清空「继续线程」输入框，重新发起一次调用。"
          : cause instanceof Error
            ? cause.message
            : "任务提交失败",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copySessionKey(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyFeedback("线程标识已复制到剪贴板");
    } catch {
      setCopyFeedback("复制失败，请手动选择并复制");
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="直接调用"
        title="在线调用"
        copy="选择 Codex 或 ChatGPT Pro 网页实验通道，提交后会进入同一套持久队列"
      />
      <div className="workbench-grid">
        <section className="card form-stack">
          <div className="field">
            <label htmlFor="objective">任务内容</label>
            <textarea
              id="objective"
              rows={9}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
            />
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="execution-channel">执行通道</label>
              <select
                id="execution-channel"
                value={executionChannel}
                onChange={(event) => {
                  const channel = event.target.value as "codex" | "chatgpt_web";
                  setExecutionChannel(channel);
                  setModel(channel === "chatgpt_web" ? "chatgpt-web.auto" : "auto");
                  if (channel === "chatgpt_web") {
                    setSessionMode("ephemeral");
                    setSessionKey("");
                  }
                }}
              >
                <option value="codex">Codex 订阅通道</option>
                <option value="chatgpt_web" disabled={!chatGptWebAvailable}>
                  ChatGPT Pro 网页实验通道
                  {chatGptWebAvailable ? "" : "（当前关闭）"}
                </option>
              </select>
              <small className="muted">
                {executionChannel === "chatgpt_web"
                  ? "通过 VPS 上可见网页发送文本，网页登录失效或结构变化时会直接失败"
                  : chatGptWebAvailable
                    ? "通过官方 Codex SDK 执行，可以使用隔离工作区和实时搜索"
                    : "ChatGPT 网页实验通道尚未通过真实调用门禁；当前只能使用 Codex 通道"}
              </small>
            </div>
            <div className="field">
              <label htmlFor="model">模型</label>
              <select id="model" value={model} onChange={(event) => setModel(event.target.value)}>
                <option value={executionChannel === "chatgpt_web" ? "chatgpt-web.auto" : "auto"}>
                  自动选择
                </option>
                {models
                  .filter(
                    (item) =>
                      item.available &&
                      item.enabled &&
                      (item.provider ?? "codex") === executionChannel,
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
              </select>
            </div>
            {executionChannel === "codex" ? (
              <div className="field">
                <label htmlFor="effort">推理等级</label>
                <select
                  id="effort"
                  value={effort}
                  onChange={(event) => setEffort(event.target.value)}
                >
                  <option value="low">低（low）</option>
                  <option value="medium">中（medium）</option>
                  <option value="high">高（high）</option>
                  <option value="xhigh">超高（xhigh）</option>
                </select>
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="kind">任务类型</label>
              <select
                id="kind"
                value={taskKind}
                onChange={(event) => setTaskKind(event.target.value)}
              >
                <option value="general">通用</option>
                <option value="bounded">结构化</option>
                <option value="coding">编码</option>
                <option value="review">审查</option>
                <option value="planning">规划</option>
                <option value="batch">批处理</option>
              </select>
            </div>
          </div>
          {executionChannel === "chatgpt_web" ? (
            <div className="form-grid">
              <div className="field">
                <label htmlFor="chatgpt-mode">网页模式</label>
                <select
                  id="chatgpt-mode"
                  value={chatgptMode}
                  onChange={(event) => {
                    const nextMode = event.target.value as "chat" | "search" | "deep_research";
                    setChatgptMode(nextMode);
                  }}
                >
                  <option value="chat">普通聊天</option>
                  <option value="search">联网搜索</option>
                  <option value="deep_research">深度研究</option>
                </select>
              </div>
              <label className="check-row">
                <input type="checkbox" checked={temporaryChat} disabled readOnly />
                每次调用使用新的非个性化临时对话
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={requireSources}
                  onChange={(event) => setRequireSources(event.target.checked)}
                />
                必须返回可提取的网页来源
              </label>
              <small className="muted">
                不读取既有记忆、自定义指令或插件；网页通道恢复前仍保持关闭
              </small>
            </div>
          ) : null}
          {executionChannel === "codex" ? (
            <>
              <div className="field">
                <label htmlFor="permission-preset">执行权限</label>
                <select
                  id="permission-preset"
                  value={permissionPreset}
                  onChange={(event) =>
                    setPermissionPreset(event.target.value as "restricted" | "confirm" | "full")
                  }
                >
                  <option value="full">隔离区完全访问（默认）</option>
                  <option value="confirm">执行前确认</option>
                  <option value="restricted">受限模式</option>
                </select>
                <small className="muted">
                  {permissionPreset === "full"
                    ? "可写本次一次性工作区并访问公开互联网，不会读取宿主机、凭据或其他调用"
                    : permissionPreset === "confirm"
                      ? "权限范围与隔离区完全访问相同，但必须先在权限确认页面授权"
                      : "只能读取本次任务工作区，不能联网或写入文件"}
                </small>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="session-mode">会话模式</label>
                  <select
                    id="session-mode"
                    value={sessionMode}
                    onChange={(event) =>
                      setSessionMode(event.target.value as "ephemeral" | "persistent")
                    }
                  >
                    <option value="ephemeral">一次性（默认）</option>
                    <option value="persistent">保留会话</option>
                  </select>
                  <small className="muted">
                    {sessionMode === "persistent"
                      ? "调用成功后生成可继续的对话线程，24 小时内有效，会出现在「会话线程」页面"
                      : "调用结束后不保留任何上下文，每次都从零开始"}
                  </small>
                </div>
                <div className="field">
                  <label htmlFor="session-key">继续线程（可选）</label>
                  <input
                    id="session-key"
                    value={sessionKey}
                    onChange={(event) => setSessionKey(event.target.value)}
                    placeholder="粘贴线程标识，接着上次继续"
                    autoComplete="off"
                  />
                  <small className="muted">
                    在「会话线程」页面点「继续对话」会自动填入，也可以手动粘贴
                  </small>
                </div>
              </div>
            </>
          ) : (
            <p className="muted">
              网页任务固定使用全新普通对话，不保留 Router 会话线程，也不访问任务工作区
            </p>
          )}
          <div className="field">
            <label htmlFor="schema">可选 JSON Schema</label>
            <textarea
              id="schema"
              rows={6}
              placeholder={
                '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}'
              }
              value={schemaText}
              onChange={(event) => setSchemaText(event.target.value)}
            />
          </div>
          <button
            className="button primary"
            disabled={busy || !objective.trim()}
            onClick={() => void submit()}
          >
            {busy
              ? executionChannel === "chatgpt_web"
                ? "网页正在处理"
                : "Codex 正在处理"
              : "提交调用"}
          </button>
          <ErrorNotice message={error} />
        </section>
        <section className="card result-panel" aria-live="polite">
          <div className="row">
            <h3>执行结果</h3>
            <span className={`pill ${job ? statusClass(job.status) : "muted"}`}>
              {job ? JOB_STATUS_LABEL[job.status] : "等待提交"}
            </span>
          </div>
          {job ? (
            <>
              <dl className="detail-list">
                <div>
                  <dt>任务编号</dt>
                  <dd>
                    <code>{job.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>实际模型</dt>
                  <dd>{job.route?.model ?? "等待路由"}</dd>
                </div>
                <div>
                  <dt>API 等效成本</dt>
                  <dd>
                    {job.usage.measurementStatus === "unavailable"
                      ? "网页未提供可靠数据"
                      : formatUsd(apiEquivalentUsd(job))}
                  </dd>
                </div>
                <div>
                  <dt>单次额度变化</dt>
                  <dd>
                    {job.usage.measurementStatus === "unavailable"
                      ? "网页未提供可靠数据"
                      : formatQuotaDelta(job.usage.quotaWindowDeltaPercent)}
                  </dd>
                </div>
                {job.task.executionChannel === "chatgpt_web" ? (
                  <div>
                    <dt>尝试次数</dt>
                    <dd>
                      {job.usage.attemptCount ?? 1} 次
                      {(job.usage.retryCount ?? 0) > 0
                        ? `，其中安全重试 ${job.usage.retryCount} 次`
                        : "，没有重试"}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {job.task.sessionKey ? (
                <div className="review-summary">
                  <div className="row">
                    <span className="eyebrow">会话线程</span>
                    <button
                      className="button compact"
                      onClick={() => void copySessionKey(job.task.sessionKey ?? "")}
                    >
                      复制线程标识
                    </button>
                  </div>
                  <code>{job.task.sessionKey}</code>
                  <p className="muted">
                    这段对话已保留，24 小时内可凭线程标识继续。可在{" "}
                    <Link className="text-link" href="/console/threads">
                      会话线程
                    </Link>{" "}
                    页面查看全部线程，或直接点「继续对话」回到这里。
                  </p>
                  <p className="muted" role="status" aria-live="polite">
                    {copyFeedback}
                  </p>
                </div>
              ) : null}
              <pre className="code-panel result-output">
                {job.output == null
                  ? (job.errorMessage ?? "任务正在执行")
                  : typeof job.output === "string"
                    ? job.output
                    : JSON.stringify(job.output, null, 2)}
              </pre>
            </>
          ) : (
            <p className="muted">提交后会在这里显示状态、模型、用量和输出</p>
          )}
        </section>
      </div>
    </>
  );
}

function Jobs() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const selectedId = useRef<string | null>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const requestedJobId = useRef<string | null>(null);
  const [missingJobId, setMissingJobId] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<JobEventRecord[]>([]);

  useEffect(() => {
    requestedJobId.current = new URLSearchParams(window.location.search).get("job");
  }, []);
  useEffect(() => {
    selectedId.current = selected?.id ?? null;
  }, [selected]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await routerFetch<{ data: Job[] }>("/api/v1/jobs?limit=100", { signal });
      setJobs(result.data);
      const requestedId = selectedId.current ?? requestedJobId.current;
      if (requestedId) {
        const match = result.data.find((job) => job.id === requestedId);
        if (match) {
          setSelected(match);
          selectedId.current = match.id;
          setMissingJobId(null);
        } else {
          try {
            const requestedJob = await routerFetch<Job>(
              `/api/v1/jobs/${encodeURIComponent(requestedId)}`,
              { signal },
            );
            setSelected(requestedJob);
            selectedId.current = requestedJob.id;
            setMissingJobId(null);
          } catch {
            setSelected(null);
            selectedId.current = null;
            setMissingJobId(requestedId);
          }
        }
      }
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务列表读取失败");
    }
  }, []);
  useEffect(() => {
    const syncFromAddress = () => {
      const nextId = new URLSearchParams(window.location.search).get("job");
      requestedJobId.current = nextId;
      selectedId.current = nextId;
      if (!nextId) {
        setSelected(null);
        setMissingJobId(null);
        return;
      }
      void refresh();
    };
    window.addEventListener("popstate", syncFromAddress);
    return () => window.removeEventListener("popstate", syncFromAddress);
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer || document.hidden) return;
      void refresh(controller.signal);
      timer = setInterval(() => void refresh(controller.signal), 3000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const visibility = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stop();
      controller.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [refresh]);

  useEffect(() => {
    if (!selected) return;
    detailHeadingRef.current?.focus();
    detailHeadingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected?.id]);

  useEffect(() => {
    if (!selected) {
      setSelectedEvents([]);
      return;
    }
    const controller = new AbortController();
    void routerFetch<{ data: JobEventRecord[] }>(
      `/api/v1/jobs/${encodeURIComponent(selected.id)}/events`,
      { signal: controller.signal },
    )
      .then((result) => setSelectedEvents(result.data))
      .catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setSelectedEvents([]);
      });
    return () => controller.abort();
  }, [selected?.id, selected?.status]);

  function selectJob(job: Job) {
    selectedId.current = job.id;
    requestedJobId.current = job.id;
    setMissingJobId(null);
    setSelected(job);
  }

  function closeDetails() {
    selectedId.current = null;
    requestedJobId.current = null;
    setSelected(null);
    setMissingJobId(null);
    router.push("/console/jobs", { scroll: false });
    requestAnimationFrame(() => listHeadingRef.current?.focus());
  }
  const [cancelTarget, setCancelTarget] = useState<Job | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  async function cancel(job: Job) {
    setCancelBusy(true);
    try {
      await routerFetch<Job>(`/api/v1/jobs/${job.id}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: "{}",
      });
      await refresh();
      setCancelTarget(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取消失败");
    } finally {
      setCancelBusy(false);
    }
  }
  const resultSummary = selected ? getJobResultSummary(selected) : null;
  return (
    <>
      <PageHeading
        eyebrow="持久队列"
        title="调用记录"
        copy="查看每次 API 或网页调用的状态、结果、用量和错误"
        action={
          <button className="button" onClick={() => void refresh()}>
            刷新
          </button>
        }
      />
      <ErrorNotice message={error} />
      {missingJobId ? (
        <section className="card console-section" role="status">
          <h3>找不到这条调用记录</h3>
          <p className="muted">记录可能已删除，或者当前账号无权查看</p>
          <button className="button" onClick={closeDetails}>
            返回调用记录
          </button>
        </section>
      ) : null}
      {selected ? (
        <section className="card console-section">
          <div className="row">
            <div>
              <h3 ref={detailHeadingRef} tabIndex={-1}>
                调用详情
              </h3>
              <code>{selected.id}</code>
            </div>
            <div className="row">
              <button className="button" onClick={closeDetails}>
                返回调用记录
              </button>
              {!TERMINAL.has(selected.status) ? (
                <button className="button danger-button" onClick={() => setCancelTarget(selected)}>
                  取消调用
                </button>
              ) : null}
            </div>
          </div>
          {resultSummary ? (
            <section className="review-summary" aria-labelledby="review-summary-title">
              <span className="eyebrow">{resultSummary.label}</span>
              <h4 id="review-summary-title">{resultSummary.title}</h4>
              <p>{resultSummary.description}</p>
              {resultSummary.details.length ? (
                <ul>
                  {resultSummary.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              ) : null}
              <p className="muted">下一步：{resultSummary.action}</p>
              {selected.validation ? (
                <p className="muted">
                  格式检查
                  {selected.validation.schemaPassed == null
                    ? "未设置"
                    : selected.validation.schemaPassed
                      ? "通过"
                      : "未通过"}
                  {" · "}验收条件 {selected.validation.testsPassed} 项通过，
                  {selected.validation.testsFailed} 项未通过
                </p>
              ) : null}
            </section>
          ) : null}
          <dl className="detail-list">
            <div>
              <dt>状态</dt>
              <dd>{resultSummary?.label ?? JOB_STATUS_LABEL[selected.status]}</dd>
            </div>
            <div>
              <dt>目标</dt>
              <dd>{selected.task.objective}</dd>
            </div>
            <div>
              <dt>路由</dt>
              <dd>
                {selected.route
                  ? `${selected.route.model} · ${selected.route.reasonCode}`
                  : "等待路由"}
              </dd>
            </div>
            <div>
              <dt>执行通道</dt>
              <dd>
                {selected.task.executionChannel === "chatgpt_web"
                  ? "ChatGPT Pro 网页实验通道"
                  : "Codex 订阅通道"}
              </dd>
            </div>
            {selected.task.executionChannel === "chatgpt_web" ? (
              <>
                <div>
                  <dt>网页模式</dt>
                  <dd>
                    {selected.task.chatgptWeb?.mode === "deep_research"
                      ? "深度研究"
                      : selected.task.chatgptWeb?.mode === "search"
                        ? "联网搜索"
                        : "普通聊天"}
                  </dd>
                </div>
                <div>
                  <dt>计量数据</dt>
                  <dd>网页未提供可靠 Token、Credits、额度变化或 API 等效成本</dd>
                </div>
                <div>
                  <dt>处理时长</dt>
                  <dd>
                    {selected.usage.durationMs == null
                      ? "网页未提供可靠数据"
                      : `${(selected.usage.durationMs / 1000).toFixed(1)} 秒`}
                  </dd>
                </div>
                <div>
                  <dt>来源</dt>
                  <dd>
                    {selected.usage.sourceCount == null
                      ? "网页未提供可靠数据"
                      : `${selected.usage.sourceCount} 个公网链接`}
                  </dd>
                </div>
              </>
            ) : (
              <>
                <div>
                  <dt>Token 数</dt>
                  <dd>
                    {selected.usage.inputTokens} 输入 · {selected.usage.cachedInputTokens} 缓存输入
                    · {selected.usage.outputTokens} 输出
                  </dd>
                </div>
                <div>
                  <dt>API 等效成本</dt>
                  <dd>{formatUsd(apiEquivalentUsd(selected))}，按同模型官方 API Token 单价估算</dd>
                </div>
                <div>
                  <dt>单次额度变化</dt>
                  <dd>
                    {formatQuotaDelta(selected.usage.quotaWindowDeltaPercent)}
                    ，根据调用前后同一额度周期快照计算
                  </dd>
                </div>
                <div>
                  <dt>额度周期使用率快照</dt>
                  <dd>
                    {selected.usage.quotaUsedPercentBefore == null
                      ? "—"
                      : `${selected.usage.quotaUsedPercentBefore}%`}
                    {" → "}
                    {selected.usage.quotaUsedPercentAfter == null
                      ? "—"
                      : `${selected.usage.quotaUsedPercentAfter}%`}
                  </dd>
                </div>
                <div>
                  <dt>每千 Token 等效价</dt>
                  <dd>{formatUsd(perThousandTokens(selected))}</dd>
                </div>
                <div>
                  <dt>Codex Credits</dt>
                  <dd>{formatCredits(selected.usage.codexCredits)}，保留用于审计和核对</dd>
                </div>
                <div>
                  <dt>订阅摊销</dt>
                  <dd>
                    {selected.usage.allocatedSubscriptionUsd == null
                      ? "尚未结算，不计作本次实际扣款"
                      : formatUsd(selected.usage.allocatedSubscriptionUsd)}
                  </dd>
                </div>
              </>
            )}
            <div>
              <dt>错误</dt>
              <dd>
                {selected.errorCode ? `${selected.errorCode} · ${selected.errorMessage}` : "无"}
              </dd>
            </div>
          </dl>
          <pre className="code-panel result-output">
            {selected.output == null
              ? "当前没有输出"
              : typeof selected.output === "string"
                ? selected.output
                : JSON.stringify(selected.output, null, 2)}
          </pre>
          {selected.task.executionChannel === "chatgpt_web" ? (
            <section className="console-section" aria-labelledby="job-sources-title">
              <h4 id="job-sources-title">网页来源</h4>
              {selectedEvents
                .filter((event) => event.data.kind === "chatgpt_web_sources")
                .flatMap((event) =>
                  Array.isArray(event.data.sources)
                    ? event.data.sources.filter(
                        (source): source is string => typeof source === "string",
                      )
                    : [],
                ).length ? (
                <ul>
                  {selectedEvents
                    .filter((event) => event.data.kind === "chatgpt_web_sources")
                    .flatMap((event) =>
                      Array.isArray(event.data.sources)
                        ? event.data.sources.filter(
                            (source): source is string => typeof source === "string",
                          )
                        : [],
                    )
                    .map((source) => (
                      <li key={source}>
                        <a className="text-link" href={source} target="_blank" rel="noreferrer">
                          {source}
                        </a>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="muted">这次网页调用没有提取到可验证的公网来源</p>
              )}
            </section>
          ) : null}
        </section>
      ) : null}
      <h3 className="section-heading" ref={listHeadingRef} tabIndex={-1}>
        全部调用
      </h3>
      <JobTable jobs={jobs} onSelect={selectJob} />
      <NativeDialog open={cancelTarget != null} onClose={() => setCancelTarget(null)}>
        <form
          method="dialog"
          className="dialog-content"
          onSubmit={(event) => event.preventDefault()}
        >
          <span className="eyebrow">不可中断的结果可能仍会返回</span>
          <h3>确认取消调用</h3>
          <p className="muted">调用 {cancelTarget?.id.slice(0, 8)} 将进入取消流程</p>
          <div className="dialog-actions">
            <button
              className="button"
              autoFocus
              onClick={() => setCancelTarget(null)}
              disabled={cancelBusy}
            >
              返回
            </button>
            <button
              className="button primary"
              onClick={() => cancelTarget && void cancel(cancelTarget)}
              disabled={cancelBusy}
            >
              {cancelBusy ? "正在取消" : "确认取消"}
            </button>
          </div>
        </form>
      </NativeDialog>
    </>
  );
}

function Routing() {
  const [objective, setObjective] = useState("审查一个普通 TypeScript 集成");
  const [taskKind, setTaskKind] = useState("review");
  const [ambiguity, setAmbiguity] = useState(1);
  const [risk, setRisk] = useState(1);
  const [decision, setDecision] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  async function preview() {
    try {
      const result = await routerFetch<Record<string, unknown>>("/api/v1/routes/preview", {
        method: "POST",
        body: JSON.stringify({ objective, taskKind, ambiguity, risk, model: "auto" }),
      });
      setDecision(result);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "路由试算失败");
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="确定性策略"
        title="路由试算"
        copy="这里只计算自动路由会选择哪个模型，不会真正发起调用"
      />
      <div className="workbench-grid">
        <section className="card form-stack">
          <div className="field">
            <label htmlFor="route-objective">任务目标</label>
            <textarea
              id="route-objective"
              rows={6}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
            />
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="route-kind">任务类型</label>
              <select
                id="route-kind"
                value={taskKind}
                onChange={(event) => setTaskKind(event.target.value)}
              >
                <option value="bounded">结构化</option>
                <option value="coding">编码</option>
                <option value="review">审查</option>
                <option value="planning">规划</option>
                <option value="batch">批处理</option>
                <option value="general">通用</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="ambiguity" className="label-with-help">
                歧义等级 {ambiguity} · {LEVEL_LABEL[ambiguity]}
                <HelpTip id="ambiguity-help">
                  <strong>默认值：1 · 低</strong>
                  <span>0 表示目标、条件和验收方式已经清楚，4 表示存在关键缺失或冲突</span>
                  <span>数值越高，系统越倾向选择处理复杂任务的模型</span>
                </HelpTip>
              </label>
              <input
                id="ambiguity"
                type="range"
                min="0"
                max="4"
                value={ambiguity}
                onChange={(event) => setAmbiguity(Number(event.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="risk" className="label-with-help">
                风险等级 {risk} · {LEVEL_LABEL[risk]}
                <HelpTip id="risk-help">
                  <strong>默认值：1 · 低</strong>
                  <span>0 表示结果容易撤销，4 表示涉及生产、安全、资金或不可逆操作</span>
                  <span>数值越高，系统越倾向选择风险处理能力更强的模型</span>
                </HelpTip>
              </label>
              <input
                id="risk"
                type="range"
                min="0"
                max="4"
                value={risk}
                onChange={(event) => setRisk(Number(event.target.value))}
              />
            </div>
          </div>
          <button className="button primary" onClick={() => void preview()}>
            开始试算
          </button>
          <ErrorNotice message={error} />
        </section>
        <section className="card">
          <h3>路由决定</h3>
          <pre className="code-panel result-output">
            {decision ? JSON.stringify(decision, null, 2) : "等待试算"}
          </pre>
        </section>
      </div>
    </>
  );
}

const QUALIFICATION_LABELS: Record<ChatGptWebQualificationSuite, string> = {
  readiness: "只读检查",
  single_probe: "真实单次探针",
  chat_3: "普通聊天 3 次",
  chat_10: "单页面基线 10 次",
  deep_2: "深度研究 2 次",
  full_10: "完整 10 项",
};

const SLOT_LABELS: Record<ChatGptWebStatus["slots"][number]["state"], string> = {
  starting: "正在启动",
  idle: "空闲",
  preparing: "正在准备",
  ready: "可以发送",
  submitted: "已经发送",
  generating: "正在生成",
  completed: "已经完成",
  quarantined: "隔离观察",
};

const PAGE_PHASE_LABELS: Record<ChatGptWebStatus["phase"], string> = {
  idle: "空闲",
  preparing: "正在准备新对话",
  input_verified: "输入已核对",
  submitted: "消息已发送",
  generating: "正在生成",
  completed: "本次调用已完成",
  failed: "本次调用失败",
  resetting: "正在回到新对话",
};

function ChatGptWebChannel() {
  const [status, setStatus] = useState<ChatGptWebStatus | null>(null);
  const [runs, setRuns] = useState<ChatGptWebQualificationRun[]>([]);
  const [confirmSuite, setConfirmSuite] = useState<ChatGptWebQualificationSuite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const [currentStatus, currentRuns] = await Promise.all([
        routerFetch<ChatGptWebStatus>("/api/v1/chatgpt-web/status", { signal }),
        routerFetch<{ data: ChatGptWebQualificationRun[] }>(
          "/api/v1/chatgpt-web/qualification-runs?limit=10",
          { signal },
        ),
      ]);
      setStatus(currentStatus);
      setRuns(currentRuns.data);
      setError("");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "网页通道状态读取失败");
    }
  }, []);
  useVisiblePolling(refresh, 5_000);
  const activeRun = runs.find((run) => ["accepted", "running"].includes(run.status));

  async function startQualification() {
    if (!confirmSuite) return;
    setBusy(true);
    try {
      await routerFetch<ChatGptWebQualificationRun>("/api/v1/chatgpt-web/qualification-runs", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ suite: confirmSuite }),
      });
      setConfirmSuite(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "验收运行创建失败");
    } finally {
      setBusy(false);
    }
  }

  const channelState = status?.configuredEnabled
    ? status.circuitState === "closed"
      ? "实验可用"
      : "自动暂停"
    : activeRun
      ? "诊断中"
      : "当前关闭";
  const retryMessage =
    status?.rateLimitState === "cooldown" && status.retryAfter
      ? `下次检查 ${formatDate(status.cooldownUntil)}，约 ${Math.ceil(status.retryAfter / 60)} 分钟后`
      : status?.rateLimitState === "recovery_probe"
        ? `恢复探针进行中，建议 ${status.retryAfter ?? 1} 秒后再检查`
        : status?.rateLimitState === "observation"
          ? "恢复观察中，需要连续 3 次成功"
          : "没有限流等待";
  const recoveryMessage = status?.lastRecoveryProbeAt
    ? `最近恢复探针 ${status.lastRecoveryProbePassed ? "通过" : "未通过"} · ${formatDate(status.lastRecoveryProbeAt)}`
    : "尚未运行恢复探针";

  return (
    <>
      <PageHeading
        eyebrow="实验执行通道"
        title="ChatGPT 网页通道"
        copy="查看可见浏览器、单页面代理和真实验收状态；单次真实探针通过前不会接收生产调用"
        action={
          <a
            className="button"
            href="/chatgpt-browser/vnc.html?autoconnect=true&resize=remote&path=chatgpt-browser/websockify"
            target="_blank"
            rel="noreferrer"
          >
            打开可见浏览器
          </a>
        }
      />
      <ErrorNotice message={error} />
      <section className="metrics console-section" aria-label="网页通道状态">
        <article className="metric">
          <small>生产状态</small>
          <strong>{channelState}</strong>
          <span className="muted">{status?.circuitReason ?? "没有熔断原因"}</span>
        </article>
        <article className="metric">
          <small>浏览器登录</small>
          <strong>{status?.authenticated ? "正常" : "需要处理"}</strong>
          <span className="muted">页面 {status?.pageReady ? "可识别" : "未就绪"}</span>
        </article>
        <article className="metric">
          <small>运行隔离</small>
          <strong>{status?.sandboxVerified ? "沙箱正常" : "尚未验证"}</strong>
          <span className="muted">扩展 {status?.extensionConnected ? "已连接" : "未连接"}</span>
        </article>
        <article className="metric">
          <small>单页面代理</small>
          <strong>
            {status?.activeTabs ?? 0}/{status?.maximumConcurrency ?? 1}
          </strong>
          <span className="muted">
            {PAGE_PHASE_LABELS[status?.phase ?? "idle"]} · 尝试 {status?.activeAttempt ?? "—"}
          </span>
        </article>
        <article className="metric">
          <small>网页限流</small>
          <strong>{status?.rateLimitState === "clear" ? "正常" : "已暂停"}</strong>
          <span className="muted">{retryMessage}</span>
          <span className="muted">{recoveryMessage}</span>
        </article>
        <article className="metric">
          <small>对话隔离</small>
          <strong>{status?.temporaryChatVerified ? "已验证" : "等待验证"}</strong>
          <span className="muted">每次调用使用新的非个性化临时对话</span>
        </article>
      </section>

      <section className="card console-section">
        <div className="row">
          <div>
            <span className="card-index">DOM 桥接 {status?.adapterVersion ?? "—"}</span>
            <h3>页面状态</h3>
          </div>
          <span className="muted">更新于 {formatDate(status?.updatedAt ?? null)}</span>
        </div>
        <div className="grid-3">
          {status?.slots.length ? (
            status.slots.map((slot, index) => (
              <article className="metric" key={slot.slotId}>
                <small>唯一工作页面 {index + 1}</small>
                <strong>{SLOT_LABELS[slot.state]}</strong>
                <span className="muted">{slot.submitted ? "本轮已经发送" : "本轮尚未发送"}</span>
              </article>
            ))
          ) : (
            <p className="muted">还没有收到页面代理状态</p>
          )}
        </div>
      </section>

      <section className="card console-section">
        <span className="card-index">管理员验收</span>
        <h3>运行真实网页门禁</h3>
        <p className="muted">
          运行前会再次确认；系统只保存脱敏结果，不保存提示词、回答、账号或对话地址
        </p>
        <div className="row action-row">
          {(Object.keys(QUALIFICATION_LABELS) as ChatGptWebQualificationSuite[]).map((suite) => (
            <button
              className={suite === "single_probe" ? "button primary" : "button"}
              key={suite}
              disabled={Boolean(activeRun)}
              onClick={() => setConfirmSuite(suite)}
            >
              {QUALIFICATION_LABELS[suite]}
            </button>
          ))}
        </div>
        {activeRun ? (
          <p className="muted">
            正在运行 {QUALIFICATION_LABELS[activeRun.suite]} · {activeRun.completed}/
            {activeRun.total}
          </p>
        ) : null}
        <p className="muted">单次真实探针是启用网页通道的最低门槛；其余套件用于可选强化观察。</p>
      </section>

      <section className="console-section">
        <div className="row">
          <h3>最近验收</h3>
          <span className="muted">只展示脱敏证据</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>验收</th>
                <th>结果</th>
                <th>进度</th>
                <th>成功</th>
                <th>结束时间</th>
              </tr>
            </thead>
            <tbody>
              {runs.length ? (
                runs.map((run) => (
                  <tr key={run.id}>
                    <td>{QUALIFICATION_LABELS[run.suite]}</td>
                    <td>
                      {run.status === "succeeded"
                        ? "通过"
                        : run.status === "failed"
                          ? "未通过"
                          : "运行中"}
                    </td>
                    <td>
                      {run.completed}/{run.total}
                    </td>
                    <td>{run.succeeded}</td>
                    <td>{formatDate(run.completedAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="muted">
                    还没有验收记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <NativeDialog open={Boolean(confirmSuite)} onClose={() => setConfirmSuite(null)}>
        <div className="dialog-content">
          <h3>确认运行{confirmSuite ? QUALIFICATION_LABELS[confirmSuite] : "验收"}</h3>
          <p>
            {confirmSuite === "readiness"
              ? "本次只检查页面和标签状态，不发送消息"
              : confirmSuite === "chat_3"
                ? "将连续发送 3 条普通聊天，最长约 30 分钟"
                : confirmSuite === "chat_10"
                  ? "将连续发送 10 条普通聊天，验证最短页面链路，最长约 2 小时"
                  : confirmSuite === "deep_2"
                    ? "将发送 2 项深度研究，最长约 2 小时"
                    : "将发送 4 项聊天、4 项搜索和 2 项深度研究，最长约 4 小时"}
          </p>
          <div className="dialog-actions">
            <button className="button" onClick={() => setConfirmSuite(null)} autoFocus>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void startQualification()}
            >
              {busy ? "正在创建" : "确认运行"}
            </button>
          </div>
        </div>
      </NativeDialog>
    </>
  );
}

function Models() {
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [webStatus, setWebStatus] = useState<ChatGptWebStatus | null>(null);
  const [error, setError] = useState("");
  const [toggleTarget, setToggleTarget] = useState<ModelRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const [catalog, snapshot, currentWebStatus] = await Promise.all([
        routerFetch<{ data: ModelRecord[] }>("/api/v1/models", { signal }),
        routerFetch<Quota>("/api/v1/quota", { signal }),
        routerFetch<ChatGptWebStatus>("/api/v1/chatgpt-web/status", { signal }),
      ]);
      setModels(catalog.data);
      setQuota(snapshot);
      setWebStatus(currentWebStatus);
      setError("");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "模型目录读取失败");
    }
  }, []);
  useVisiblePolling(refresh, 5_000);
  async function updateModel() {
    if (!toggleTarget) return;
    setBusy(true);
    try {
      await routerFetch(`/api/v1/models/${encodeURIComponent(toggleTarget.id)}`, {
        method: "PATCH",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ enabled: !toggleTarget.enabled }),
      });
      setToggleTarget(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模型设置失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="订阅容量"
        title="用量与模型"
        copy="查看 Codex 额度周期，并管理 Codex 与 ChatGPT 网页实验通道中允许手动调用的模型"
        action={
          <a
            className="button"
            href="/chatgpt-browser/vnc.html?autoconnect=true&resize=remote&path=chatgpt-browser/websockify"
            target="_blank"
            rel="noreferrer"
          >
            打开 ChatGPT 可见浏览器
          </a>
        }
      />
      <ErrorNotice message={error} />
      <section className="card console-section">
        <span className="card-index">ChatGPT Pro 网页实验通道</span>
        <h3>{webStatus?.configuredEnabled ? "实验通道可用性" : "当前关闭"}</h3>
        <p className="muted">
          {webStatus?.configuredEnabled
            ? `当前并发 ${webStatus.effectiveConcurrency}/${webStatus.maximumConcurrency} · 浏览器${webStatus.authenticated ? "已登录" : "未登录"} · 沙箱${webStatus.sandboxVerified ? "已验证" : "未验证"}`
            : "尚未通过真实调用门禁；网页任务不会进入浏览器，Codex 通道不受影响"}
        </p>
        {webStatus?.circuitReason ? (
          <p className="muted">暂停原因：{webStatus.circuitReason}</p>
        ) : null}
        <p className="muted">最近验收：{formatDate(webStatus?.lastQualifiedAt ?? null)}</p>
      </section>
      <section className="console-section">
        <div className="row">
          <h3>额度周期</h3>
          <span className={quota?.stale ? "warning" : "muted"}>
            {quota?.stale ? "数据已过期" : `更新于 ${formatDate(quota?.fetchedAt ?? null)}`}
          </span>
        </div>
        <div className="metrics">
          {(quota?.windows.length ? quota.windows : []).map((window) => (
            <article className="metric" key={window.id}>
              <small>
                {window.name} · {window.kind === "primary" ? "主周期" : "次周期"}
              </small>
              <strong>
                {getRemainingPercent(window.remainingPercent, window.usedPercent) == null
                  ? "—"
                  : `${getRemainingPercent(window.remainingPercent, window.usedPercent)}%`}
              </strong>
              <div className="progress">
                <span
                  style={{
                    width: `${getRemainingPercent(window.remainingPercent, window.usedPercent) ?? 0}%`,
                  }}
                />
              </div>
              <span className="muted">
                已使用 {window.usedPercent == null ? "—" : `${window.usedPercent}%`} ·{" "}
                {window.windowDurationMinutes ?? "—"} 分钟
              </span>
              <span className="muted">重置 {formatDate(window.resetsAt)}</span>
            </article>
          ))}
          {!quota?.windows.length ? (
            <article className="metric">
              <small>额度数据</small>
              <strong>—</strong>
              <span className="muted">当前暂不可用</span>
            </article>
          ) : null}
        </div>
      </section>
      <section className="grid-3 console-section">
        {models.map((model) => (
          <article className="card" key={model.id}>
            <span className="card-index">{model.displayName}</span>
            <h3>{model.id}</h3>
            <p className="muted">
              {model.provider === "chatgpt_web" ? "ChatGPT 网页" : "Codex"} · 当前账号
              {model.available ? "可见" : "不可见"} · Router {model.enabled ? "已启用" : "未启用"}
            </p>
            {model.provider === "chatgpt_web" ? (
              <p className="muted">
                网页动态发现 ·{" "}
                {model.streamingMode === "final_only" ? "仅返回最终完整正文" : "流式"}
              </p>
            ) : (
              <p className="muted">
                推理等级{" "}
                {model.supportedReasoningEfforts.length
                  ? model.supportedReasoningEfforts.join("、")
                  : "暂未返回"}
              </p>
            )}
            {model.creditRate && model.apiRate ? (
              <p className="muted">
                Credits {model.creditRate.input}/{model.creditRate.cachedInput}/
                {model.creditRate.output} · API US${model.apiRate.input}/{model.apiRate.cachedInput}
                /{model.apiRate.output}
              </p>
            ) : (
              <p className="muted">暂不能换算 Credits 或 API 等效价格</p>
            )}
            <button
              className="button"
              disabled={!model.available && !model.enabled}
              onClick={() => setToggleTarget(model)}
            >
              {model.enabled ? "停用" : "启用"}
            </button>
          </article>
        ))}
      </section>
      <section className="card console-section">
        <h3>计量口径</h3>
        <p className="muted">每条公式下方列出变量、单位和计算范围</p>
        <Formula
          source={String.raw`C_m=\frac{(I-K)r_i+Kr_k+Or_o}{10^6}`}
          label="Codex Credits 计算公式"
        />
        <dl className="variable-list">
          <div>
            <dt>I</dt>
            <dd>本次调用的输入 Token 总数</dd>
          </div>
          <div>
            <dt>K</dt>
            <dd>输入中命中缓存的 Token 数，K 是 I 的一部分</dd>
          </div>
          <div>
            <dt>O</dt>
            <dd>本次调用生成的输出 Token 数</dd>
          </div>
          <div>
            <dt>rᵢ</dt>
            <dd>每 100万 个非缓存输入 Token 对应的 Codex Credits</dd>
          </div>
          <div>
            <dt>rₖ</dt>
            <dd>每 100万 个缓存输入 Token 对应的 Codex Credits</dd>
          </div>
          <div>
            <dt>rₒ</dt>
            <dd>每 100万 个输出 Token 对应的 Codex Credits</dd>
          </div>
          <div>
            <dt>Cₘ</dt>
            <dd>本次调用在模型 m 下估算的 Codex Credits</dd>
          </div>
        </dl>
        <Formula
          source={String.raw`P_{\mathrm{API}}=\frac{(I-K)p_i+Kp_k+Op_o}{10^6}`}
          label="API 等效价格计算公式"
        />
        <dl className="variable-list">
          <div>
            <dt>pᵢ</dt>
            <dd>每 100万 个非缓存输入 Token 的官方 API 美元单价</dd>
          </div>
          <div>
            <dt>pₖ</dt>
            <dd>每 100万 个缓存输入 Token 的官方 API 美元单价</dd>
          </div>
          <div>
            <dt>pₒ</dt>
            <dd>每 100万 个输出 Token 的官方 API 美元单价</dd>
          </div>
          <div>
            <dt>P API</dt>
            <dd>同一批 Token 改用官方 API 时的理论美元价格，不是 Pro 的单次扣款</dd>
          </div>
        </dl>
        <Formula
          source={String.raw`\Delta Q_w=Q_{\mathrm{after},w}-Q_{\mathrm{before},w}`}
          label="单次额度变化公式"
        />
        <dl className="variable-list">
          <div>
            <dt>w</dt>
            <dd>本次比较使用的同一个额度周期</dd>
          </div>
          <div>
            <dt>Q before,w</dt>
            <dd>调用前周期 w 的已用比例</dd>
          </div>
          <div>
            <dt>Q after,w</dt>
            <dd>调用后周期 w 的已用比例</dd>
          </div>
          <div>
            <dt>ΔQw</dt>
            <dd>本次调用带来的额度变化，单位是百分点</dd>
          </div>
        </dl>
        <Formula
          source={String.raw`P_{1000}=\frac{1000P_{\mathrm{API}}}{I+O}`}
          label="每千 Token API 等效价格公式"
        />
        <dl className="variable-list">
          <div>
            <dt>P1000</dt>
            <dd>每 1000 个输入和输出 Token 的 API 等效价格</dd>
          </div>
          <div>
            <dt>I + O</dt>
            <dd>输入与输出 Token 总数，缓存输入已经包含在 I 中，不重复相加</dd>
          </div>
        </dl>
        <Formula source={String.raw`A_j=M\frac{C_j}{\sum_k C_k}`} label="月度订阅摊销公式" />
        <dl className="variable-list">
          <div>
            <dt>M</dt>
            <dd>本结算周期的订阅费用</dd>
          </div>
          <div>
            <dt>Cj</dt>
            <dd>第 j 次调用使用的 Codex Credits</dd>
          </div>
          <div>
            <dt>ΣCk</dt>
            <dd>本结算周期全部调用的 Codex Credits 总和</dd>
          </div>
          <div>
            <dt>Aj</dt>
            <dd>按照 Credits 比例分配给第 j 次调用的订阅费用</dd>
          </div>
        </dl>
        <p className="muted">订阅摊销只在结算周期结束后计算，不代表 OpenAI 对单次调用收费</p>
        <dl className="detail-list">
          <div>
            <dt>额度使用比例</dt>
            <dd>官方额度周期的已用比例，不代表单项调用成本</dd>
          </div>
          <div>
            <dt>单次额度变化</dt>
            <dd>调用前后同一额度周期读数相差的百分点，读数不变时显示低于当前精度</dd>
          </div>
          <div>
            <dt>Codex Credits</dt>
            <dd>按模型的每百万输入、缓存输入和输出 Token 费率计算，可出现小数</dd>
          </div>
          <div>
            <dt>API 等效价</dt>
            <dd>把同一批 Token 按官方 API 单价重算，仅用于比较，不是 Pro 订阅的按次扣款</dd>
          </div>
          <div>
            <dt>订阅摊销</dt>
            <dd>需要月末总 Credits 和订阅费用才能结算，系统不会用不完整数据伪造单项成本</dd>
          </div>
        </dl>
      </section>
      <NativeDialog open={toggleTarget != null} onClose={() => setToggleTarget(null)}>
        <form
          method="dialog"
          className="dialog-content"
          onSubmit={(event) => event.preventDefault()}
        >
          <span className="eyebrow">模型设置</span>
          <h3>确认{toggleTarget?.enabled ? "停用" : "启用"}模型</h3>
          <p className="muted">
            {toggleTarget?.displayName}（{toggleTarget?.id}）将
            {toggleTarget?.enabled ? "不能再接收新调用" : "可以在在线调用和 API 中手动指定"}
          </p>
          <div className="dialog-actions">
            <button
              className="button"
              autoFocus
              disabled={busy}
              onClick={() => setToggleTarget(null)}
            >
              返回
            </button>
            <button className="button primary" disabled={busy} onClick={() => void updateModel()}>
              {busy ? "正在保存" : "确认更改"}
            </button>
          </div>
        </form>
      </NativeDialog>
    </>
  );
}

function Keys() {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [name, setName] = useState("AIALRA Agent");
  const [createdKey, setCreatedKey] = useState("");
  const [rateLimit, setRateLimit] = useState(60);
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [keyKind, setKeyKind] = useState<"ordinary" | "trusted">("ordinary");
  const [allowChatGptWeb, setAllowChatGptWeb] = useState(false);
  const [createConfirm, setCreateConfirm] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRecord | null>(null);
  const [confirmationPrefix, setConfirmationPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setKeys((await routerFetch<{ data: ApiKeyRecord[] }>("/api/v1/keys")).data);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "密钥列表读取失败");
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function createKey() {
    setBusy(true);
    try {
      const record = await routerFetch<ApiKeyRecord>("/api/v1/keys", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          name,
          scopes: [
            "jobs:read",
            "jobs:write",
            "quota:read",
            ...(allowChatGptWeb ? ["chatgpt:web"] : []),
          ],
          rateLimitPerMinute: rateLimit,
          expiresAt:
            expiresInDays === "never"
              ? null
              : new Date(Date.now() + Number(expiresInDays) * 86_400_000).toISOString(),
          executionPolicy:
            keyKind === "trusted"
              ? {
                  defaultPreset: "full",
                  allowedPresets: ["restricted", "confirm", "full"],
                }
              : { defaultPreset: "restricted", allowedPresets: ["restricted"] },
        }),
      });
      setCreatedKey(record.key ?? "");
      setCreateConfirm(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "密钥创建失败");
    } finally {
      setBusy(false);
    }
  }
  async function revoke(key: ApiKeyRecord) {
    setBusy(true);
    try {
      await routerFetch(`/api/v1/keys/${key.id}/revoke`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ confirmationPrefix }),
      });
      setRevokeTarget(null);
      setConfirmationPrefix("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "密钥吊销失败");
    } finally {
      setBusy(false);
    }
  }
  async function copyKey() {
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopyFeedback("已复制到剪贴板");
    } catch {
      setCopyFeedback("复制失败，请手动选择并复制");
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="访问控制"
        title="API 密钥"
        copy="密钥明文只在创建后显示一次，随后只能查看前缀、范围和状态"
      />
      <ErrorNotice message={error} />
      <section className="card form-stack">
        <div className="field">
          <label htmlFor="key-name">密钥名称</label>
          <input id="key-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="key-kind">密钥类型</label>
            <select
              id="key-kind"
              value={keyKind}
              onChange={(event) => setKeyKind(event.target.value as "ordinary" | "trusted")}
            >
              <option value="ordinary">普通密钥（受限模式）</option>
              <option value="trusted">可信 Agent（默认完全访问）</option>
            </select>
            <small className="muted">
              {keyKind === "trusted"
                ? "需要管理员在五分钟内重新认证，仍只访问单次隔离工作区"
                : "只能读取任务工作区，不能写入或联网"}
            </small>
            {keyKind === "trusted" ? (
              <a className="text-link" href="/_aialra_auth/logout?returnTo=/console/keys">
                重新登录以刷新认证时间
              </a>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="key-rate">每分钟请求数</label>
            <input
              id="key-rate"
              type="number"
              min="1"
              max="10000"
              value={rateLimit}
              onChange={(event) => setRateLimit(Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="key-expiry">有效期</label>
            <select
              id="key-expiry"
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(event.target.value)}
            >
              <option value="30">30 天（默认）</option>
              <option value="90">90 天</option>
              <option value="365">365 天</option>
              <option value="never">永不过期（管理员）</option>
            </select>
          </div>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={allowChatGptWeb}
            onChange={(event) => setAllowChatGptWeb(event.target.checked)}
          />
          允许使用 ChatGPT Pro 网页实验通道
        </label>
        <small className="muted">
          该通道依赖管理员在可见浏览器中的 ChatGPT 登录状态，可能因验证页面或界面变化中断
        </small>
        <div>
          <button
            className="button primary"
            disabled={!name.trim() || busy}
            onClick={() => setCreateConfirm(true)}
          >
            核对并创建
          </button>
        </div>
      </section>
      {createdKey ? (
        <section className="card secret-once">
          <h3>立即离线保存</h3>
          <p className="warning">关闭或刷新页面后不会再次显示</p>
          <pre className="code-panel">{createdKey}</pre>
          <button className="button" onClick={() => void copyKey()}>
            复制密钥
          </button>
          <button
            className="button"
            onClick={() => {
              setCreatedKey("");
              setCopyFeedback("密钥已隐藏");
            }}
          >
            已保存并隐藏
          </button>
        </section>
      ) : null}
      <p className="muted" role="status" aria-live="polite">
        {copyFeedback}
      </p>
      <div className="table-wrap console-section">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>前缀</th>
              <th>范围</th>
              <th>执行权限</th>
              <th>速率</th>
              <th>到期时间</th>
              <th>最后使用</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 ? (
              <tr>
                <td colSpan={9} className="muted">
                  当前没有 API 密钥
                </td>
              </tr>
            ) : (
              keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td>
                    <code>{key.prefix}</code>
                  </td>
                  <td>{key.scopes.join(", ")}</td>
                  <td>
                    {key.executionPolicy.defaultPreset === "full"
                      ? "可信 Agent"
                      : key.executionPolicy.defaultPreset === "confirm"
                        ? "执行前确认"
                        : "受限模式"}
                  </td>
                  <td>{key.rateLimitPerMinute} 次/分钟</td>
                  <td>{formatDate(key.expiresAt)}</td>
                  <td>{formatDate(key.lastUsedAt)}</td>
                  <td className={key.revokedAt ? "danger" : "success"}>
                    {key.revokedAt ? "已吊销" : "有效"}
                  </td>
                  <td>
                    {!key.revokedAt ? (
                      <button
                        className="button compact"
                        onClick={() => {
                          setRevokeTarget(key);
                          setConfirmationPrefix("");
                        }}
                      >
                        吊销
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <NativeDialog open={createConfirm} onClose={() => setCreateConfirm(false)}>
        <form
          method="dialog"
          className="dialog-content"
          onSubmit={(event) => event.preventDefault()}
        >
          <span className="eyebrow">确认前不会发送请求</span>
          <h3>核对 API 密钥</h3>
          <dl className="detail-list">
            <div>
              <dt>名称</dt>
              <dd>{name}</dd>
            </div>
            <div>
              <dt>作用域</dt>
              <dd>
                任务读取、任务写入、额度读取
                {allowChatGptWeb ? "、ChatGPT 网页实验通道" : ""}
              </dd>
            </div>
            <div>
              <dt>执行权限</dt>
              <dd>
                {keyKind === "trusted" ? "可信 Agent · 隔离区完全访问" : "普通密钥 · 受限模式"}
              </dd>
            </div>
            <div>
              <dt>速率</dt>
              <dd>{rateLimit} 次/分钟</dd>
            </div>
            <div>
              <dt>有效期</dt>
              <dd>{expiresInDays === "never" ? "永不过期" : `${expiresInDays} 天`}</dd>
            </div>
          </dl>
          <div className="dialog-actions">
            <button
              className="button"
              autoFocus
              disabled={busy}
              onClick={() => setCreateConfirm(false)}
            >
              返回编辑
            </button>
            <button className="button primary" disabled={busy} onClick={() => void createKey()}>
              {busy ? "正在创建" : "确认创建"}
            </button>
          </div>
        </form>
      </NativeDialog>
      <NativeDialog open={revokeTarget != null} onClose={() => setRevokeTarget(null)}>
        <form
          method="dialog"
          className="dialog-content"
          onSubmit={(event) => event.preventDefault()}
        >
          <span className="eyebrow">此操作会立即阻止后续调用</span>
          <h3>确认吊销密钥</h3>
          <p>
            {revokeTarget?.name} · <code>{revokeTarget?.prefix}</code>
          </p>
          <div className="field">
            <label htmlFor="revoke-prefix">输入当前前缀以确认</label>
            <input
              id="revoke-prefix"
              value={confirmationPrefix}
              onChange={(event) => setConfirmationPrefix(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="dialog-actions">
            <button
              className="button"
              autoFocus
              disabled={busy}
              onClick={() => setRevokeTarget(null)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={busy || confirmationPrefix !== revokeTarget?.prefix}
              onClick={() => revokeTarget && void revoke(revokeTarget)}
            >
              {busy ? "正在吊销" : "确认吊销"}
            </button>
          </div>
        </form>
      </NativeDialog>
    </>
  );
}

function Approvals() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [decisionTarget, setDecisionTarget] = useState<{
    job: Job;
    decision: "approved" | "denied";
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await routerFetch<{ data: Job[] }>("/api/v1/jobs?limit=100", { signal });
      setJobs(result.data.filter((job) => job.status === "awaiting_approval"));
      setError("");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "待确认调用读取失败");
    }
  }, []);
  useVisiblePolling(refresh, 5_000);

  async function decide() {
    if (!decisionTarget) return;
    setBusy(true);
    try {
      await routerFetch(`/api/v1/jobs/${decisionTarget.job.id}/approvals`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          decision: decisionTarget.decision,
          reason:
            decisionTarget.decision === "approved"
              ? "管理员确认隔离区执行权限"
              : "管理员拒绝隔离区执行权限",
        }),
      });
      setDecisionTarget(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "权限决定提交失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="执行前确认"
        title="权限确认"
        copy="这里只显示选择了执行前确认的调用，普通调用和隔离区完全访问不会出现在这里"
        action={
          <button className="button" onClick={() => void refresh()}>
            刷新
          </button>
        }
      />
      <ErrorNotice message={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>调用</th>
              <th>目标</th>
              <th>权限</th>
              <th>创建时间</th>
              <th>决定</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length ? (
              jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <Link href={`/console/jobs?job=${encodeURIComponent(job.id)}`}>
                      <code>{job.id.slice(0, 8)}</code>
                    </Link>
                  </td>
                  <td>{job.task.objective}</td>
                  <td>可写一次性工作区 · 公开互联网</td>
                  <td>{formatDate(job.createdAt)}</td>
                  <td>
                    <div className="row">
                      <button
                        className="button compact"
                        onClick={() => setDecisionTarget({ job, decision: "denied" })}
                      >
                        拒绝
                      </button>
                      <button
                        className="button compact primary"
                        onClick={() => setDecisionTarget({ job, decision: "approved" })}
                      >
                        授权执行
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="muted">
                  当前没有等待授权的调用
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <NativeDialog open={decisionTarget != null} onClose={() => setDecisionTarget(null)}>
        <form
          method="dialog"
          className="dialog-content"
          onSubmit={(event) => event.preventDefault()}
        >
          <span className="eyebrow">执行权限决定</span>
          <h3>{decisionTarget?.decision === "approved" ? "确认授权执行" : "确认拒绝调用"}</h3>
          <p className="muted">{decisionTarget?.job.task.objective}</p>
          <p>
            {decisionTarget?.decision === "approved"
              ? "授权后调用会进入队列，可写本次一次性工作区并访问公开互联网"
              : "拒绝后调用会结束，不会启动 Codex Runner"}
          </p>
          <div className="dialog-actions">
            <button
              className="button"
              autoFocus
              disabled={busy}
              onClick={() => setDecisionTarget(null)}
            >
              返回
            </button>
            <button className="button primary" disabled={busy} onClick={() => void decide()}>
              {busy ? "正在提交" : "确认"}
            </button>
          </div>
        </form>
      </NativeDialog>
    </>
  );
}

function Records({ kind }: { kind: "audit" | "retention" }) {
  const [records, setRecords] = useState<Array<AuditRecord | DeletionReceipt>>([]);
  const [error, setError] = useState("");
  const definition = useMemo(
    () =>
      kind === "audit"
        ? {
            title: "操作日志",
            copy: "记录谁在什么时候提交调用、管理密钥或修改设置",
            path: "/api/v1/audit?limit=100",
          }
        : {
            title: "数据清理记录",
            copy: "查看系统何时删除过期的请求内容、结果和元数据",
            path: "/api/v1/retention/receipts?limit=100",
          },
    [kind],
  );
  useEffect(() => {
    void routerFetch<{ data: Array<AuditRecord | DeletionReceipt> }>(definition.path)
      .then((result) => setRecords(result.data))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "记录读取失败"));
  }, [definition]);
  return (
    <>
      <PageHeading eyebrow="治理记录" title={definition.title} copy={definition.copy} />
      <ErrorNotice message={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>动作或资源</th>
              <th>资源编号</th>
              <th>执行者</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  当前没有记录
                </td>
              </tr>
            ) : (
              records.map((record) => {
                const audit = record as AuditRecord;
                const receipt = record as DeletionReceipt;
                return (
                  <tr key={record.id}>
                    <td>{formatDate(audit.createdAt ?? receipt.deletedAt)}</td>
                    <td>{audit.action ?? receipt.resourceType}</td>
                    <td>
                      <code>{audit.resourceId ?? receipt.resourceId}</code>
                    </td>
                    <td>{audit.actorId ?? "系统清理流程"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

const EFFORT_LABEL: Record<string, string> = {
  minimal: "最低（minimal）",
  low: "低（low）",
  medium: "中（medium）",
  high: "高（high）",
  xhigh: "超高（xhigh）",
  max: "最高（max）",
};

function Threads() {
  const [threads, setThreads] = useState<SessionThread[]>([]);
  const [error, setError] = useState("");
  const [copyFeedback, setCopyFeedback] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await routerFetch<{ data: SessionThread[] }>("/api/v1/threads?limit=100", {
        signal,
      });
      setThreads(result.data);
      setError("");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "会话线程读取失败");
    }
  }, []);
  useVisiblePolling(refresh, 10_000);
  async function copySessionKey(sessionKey: string) {
    try {
      await navigator.clipboard.writeText(sessionKey);
      setCopyFeedback("完整线程标识已复制到剪贴板");
    } catch {
      setCopyFeedback("复制失败，请手动选择并复制");
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="多轮对话"
        title="会话线程"
        copy="开启「保留会话」的调用会留下可继续的对话线程，这里列出当前账号仍能继续的全部线程"
        action={
          <button className="button" onClick={() => void refresh()}>
            刷新
          </button>
        }
      />
      <ErrorNotice message={error} />
      <p className="muted" role="status" aria-live="polite">
        {copyFeedback}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>线程标识</th>
              <th>模型</th>
              <th>推理档位</th>
              <th>轮次</th>
              <th>最近使用</th>
              <th>到期时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {threads.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  当前没有可继续的会话线程。普通调用默认是一次性的，不保留上下文；在在线调用里把「会话模式」切换为「保留会话」后，这里会出现可继续的对话线程，线程在
                  24 小时后自动到期清除。
                </td>
              </tr>
            ) : (
              threads.map((thread) => (
                <tr key={thread.sessionKey}>
                  <td>
                    <code title={thread.sessionKey}>{truncateSessionKey(thread.sessionKey)}</code>{" "}
                    <button
                      className="button compact"
                      onClick={() => void copySessionKey(thread.sessionKey)}
                    >
                      复制
                    </button>
                  </td>
                  <td>{thread.model}</td>
                  <td>{EFFORT_LABEL[thread.effort] ?? thread.effort}</td>
                  <td>{thread.turnCount}</td>
                  <td>{formatDate(thread.lastUsedAt)}</td>
                  <td>
                    {formatDate(thread.expiresAt)}
                    <br />
                    <span className="muted">{threadExpiryLabel(thread.expiresAt)}</span>
                  </td>
                  <td>
                    <Link
                      className="button compact"
                      href={`/console/playground?session=${encodeURIComponent(thread.sessionKey)}`}
                    >
                      继续对话
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ConsoleApp({ section = "overview" }: { section?: string }) {
  const content =
    section === "overview" ? (
      <Overview />
    ) : section === "playground" ? (
      <Suspense fallback={null}>
        <Playground />
      </Suspense>
    ) : section === "jobs" ? (
      <Jobs />
    ) : section === "threads" ? (
      <Threads />
    ) : section === "routing" ? (
      <Routing />
    ) : section === "models" ? (
      <Models />
    ) : section === "chatgpt-web" ? (
      <ChatGptWebChannel />
    ) : section === "keys" ? (
      <Keys />
    ) : section === "approvals" ? (
      <Approvals />
    ) : section === "audit" ? (
      <Records kind="audit" />
    ) : section === "retention" ? (
      <Records kind="retention" />
    ) : section === "evals" ? (
      <EvaluationMethods mode="console" />
    ) : (
      <Overview />
    );
  return (
    <main id="main" className="console-main">
      <div className="private-banner">受保护控制台 · Authentik 浏览器会话已经生效</div>
      {content}
    </main>
  );
}
