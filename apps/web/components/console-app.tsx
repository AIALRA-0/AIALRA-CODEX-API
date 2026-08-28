"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type JobStatus =
  | "accepted"
  | "queued"
  | "running"
  | "validating"
  | "succeeded"
  | "needs_review"
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
  };
  route: { provider: "codex"; model: string; reasonCode: string } | null;
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
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
  };
  createdAt: string;
  updatedAt: string;
}

interface Quota {
  usedPercent: number | null;
  windowDurationMinutes: number | null;
  resetsAt: string | null;
  planType: string | null;
  source: "app-server" | "unavailable";
}

interface ModelRecord {
  alias: string;
  id: string;
  provider: "codex";
  purpose: string;
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

const TERMINAL = new Set<JobStatus>([
  "succeeded",
  "needs_review",
  "failed",
  "cancelled",
  "expired",
]);

const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  accepted: "已接收",
  queued: "排队中",
  running: "执行中",
  validating: "验证中",
  succeeded: "已成功",
  needs_review: "需要复核",
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

const MODEL_PURPOSE_LABEL: Record<string, string> = {
  luna: "边界清楚、结构化、可自动验证的高吞吐任务",
  terra: "日常编码、调试、集成和审查任务",
  sol: "高歧义规划、高风险任务和分歧裁决",
};

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
    throw new Error(error?.error?.message ?? `请求失败 HTTP ${response.status}`);
  }
  return value as T;
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
  if (status === "needs_review") return "warning";
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
            <th>任务</th>
            <th>状态</th>
            <th>Codex 模型</th>
            <th>类型</th>
            <th>API 等效成本</th>
            <th>本次额度窗口变化</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          {jobs.length === 0 ? (
            <tr>
              <td colSpan={7} className="muted">
                当前没有任务
              </td>
            </tr>
          ) : (
            jobs.map((job) => (
              <tr key={job.id}>
                <td>
                  {onSelect ? (
                    <button className="table-link" onClick={() => onSelect(job)}>
                      <code>{job.id.slice(0, 8)}</code>
                    </button>
                  ) : (
                    <code>{job.id.slice(0, 8)}</code>
                  )}
                </td>
                <td className={statusClass(job.status)}>{JOB_STATUS_LABEL[job.status]}</td>
                <td>{job.route?.model ?? job.task.model}</td>
                <td>{TASK_KIND_LABEL[job.task.taskKind] ?? job.task.taskKind}</td>
                <td>{formatUsd(apiEquivalentUsd(job))}</td>
                <td>{formatQuotaDelta(job.usage.quotaWindowDeltaPercent)}</td>
                <td>{formatDate(job.createdAt)}</td>
              </tr>
            ))
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
  const refresh = useCallback(async () => {
    try {
      const [jobResult, quotaResult] = await Promise.all([
        routerFetch<{ data: Job[] }>("/api/v1/jobs?limit=12"),
        routerFetch<Quota>("/api/v1/quota"),
      ]);
      setJobs(jobResult.data);
      setQuota(quotaResult);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "控制面读取失败");
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const active = jobs.filter((job) => !TERMINAL.has(job.status)).length;
  const succeeded = jobs.filter((job) => job.status === "succeeded").length;
  const completed = jobs.filter((job) => TERMINAL.has(job.status)).length;
  const completionRate = completed ? Math.round((succeeded / completed) * 1000) / 10 : 0;
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
            : "这里读取真实队列、额度窗口和最近任务，不使用合成数据"
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
          <small>Codex 额度使用</small>
          <strong>{quota?.usedPercent == null ? "—" : `${quota.usedPercent}%`}</strong>
          <div className="progress">
            <span style={{ width: `${quota?.usedPercent ?? 0}%` }} />
          </div>
          <span className="muted">
            来源 {quota?.source === "app-server" ? "Codex App Server" : "暂不可用"}
          </span>
        </article>
        <article className="metric">
          <small>当前活动任务</small>
          <strong>{active}</strong>
          <span className={active ? "warning" : "success"}>
            {active ? "队列正在处理" : "队列空闲"}
          </span>
        </article>
        <article className="metric">
          <small>最近任务成功率</small>
          <strong>{completed ? `${completionRate}%` : "—"}</strong>
          <span className="muted">基于最近 {jobs.length} 项任务</span>
        </article>
      </section>
      <section className="console-section">
        <div className="row">
          <h3>最近任务</h3>
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
  const [objective, setObjective] = useState("把下面内容归纳为 3 个要点，只返回结果");
  const [model, setModel] = useState("auto");
  const [effort, setEffort] = useState("medium");
  const [taskKind, setTaskKind] = useState("general");
  const [schemaText, setSchemaText] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const responseSchema = schemaText.trim() ? JSON.parse(schemaText) : undefined;
      const created = await routerFetch<Job>("/api/v1/jobs", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          task: {
            objective,
            model,
            effort,
            taskKind,
            expectedOutput: responseSchema
              ? "按照指定 JSON Schema 返回"
              : "返回可直接使用的最终结果",
            validation: { responseSchema, acceptanceTests: [] },
            permissions: {
              filesystem: "read",
              network: "none",
              allowedHosts: [],
              requireApprovalForWrites: true,
              requireApprovalForExternalActions: true,
            },
            deadlineMs: 120000,
            budget: { maxOutputTokens: 8192, maxAttempts: 2 },
          },
          metadata: { source: "private-console" },
        }),
      });
      setJob(created);
      let current = created;
      while (!TERMINAL.has(current.status)) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        current = await routerFetch<Job>(`/api/v1/jobs/${created.id}`);
        setJob(current);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务提交失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="直接调用"
        title="Codex 在线调用"
        copy="填写任务后直接进入持久队列，页面会持续读取状态并显示最终结果"
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
              <label htmlFor="model">模型</label>
              <select id="model" value={model} onChange={(event) => setModel(event.target.value)}>
                <option value="auto">自动选择</option>
                <option value="luna">Luna</option>
                <option value="terra">Terra</option>
                <option value="sol">Sol</option>
              </select>
            </div>
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
            {busy ? "Codex 正在处理" : "提交任务"}
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
                  <dd>{formatUsd(apiEquivalentUsd(job))}</dd>
                </div>
                <div>
                  <dt>本次额度窗口变化</dt>
                  <dd>{formatQuotaDelta(job.usage.quotaWindowDeltaPercent)}</dd>
                </div>
              </dl>
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
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const selectedId = useRef<string | null>(null);
  useEffect(() => {
    selectedId.current = selected?.id ?? null;
  }, [selected]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await routerFetch<{ data: Job[] }>("/api/v1/jobs?limit=100", { signal });
      setJobs(result.data);
      if (selectedId.current) {
        setSelected(
          (current) => result.data.find((job) => job.id === selectedId.current) ?? current,
        );
      }
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务列表读取失败");
    }
  }, []);
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
  return (
    <>
      <PageHeading
        eyebrow="持久队列"
        title="任务管理"
        copy="查看真实状态、Token、API 等效成本和单次额度窗口变化"
        action={
          <button className="button" onClick={() => void refresh()}>
            刷新
          </button>
        }
      />
      <ErrorNotice message={error} />
      <JobTable jobs={jobs} onSelect={setSelected} />
      {selected ? (
        <section className="card console-section">
          <div className="row">
            <div>
              <h3>任务详情</h3>
              <code>{selected.id}</code>
            </div>
            {!TERMINAL.has(selected.status) ? (
              <button className="button danger-button" onClick={() => setCancelTarget(selected)}>
                取消任务
              </button>
            ) : null}
          </div>
          <dl className="detail-list">
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
              <dt>Token 数</dt>
              <dd>
                {selected.usage.inputTokens} 输入 · {selected.usage.cachedInputTokens} 缓存输入 ·{" "}
                {selected.usage.outputTokens} 输出
              </dd>
            </div>
            <div>
              <dt>API 等效成本</dt>
              <dd>{formatUsd(apiEquivalentUsd(selected))}，按同模型官方 API Token 单价估算</dd>
            </div>
            <div>
              <dt>本次额度窗口变化</dt>
              <dd>
                {formatQuotaDelta(selected.usage.quotaWindowDeltaPercent)}
                ，根据任务前后同一窗口快照计算
              </dd>
            </div>
            <div>
              <dt>窗口使用率快照</dt>
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
        </section>
      ) : null}
      <NativeDialog open={cancelTarget != null} onClose={() => setCancelTarget(null)}>
        <form
          method="dialog"
          className="dialog-content"
          onSubmit={(event) => event.preventDefault()}
        >
          <span className="eyebrow">不可中断的结果可能仍会返回</span>
          <h3>确认取消任务</h3>
          <p className="muted">任务 {cancelTarget?.id.slice(0, 8)} 将进入取消流程</p>
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
      setError(cause instanceof Error ? cause.message : "路由预览失败");
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="确定性策略"
        title="路由预览"
        copy="预览只计算 Codex 的 Luna、Terra 或 Sol 选择，不会创建任务"
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
              <label htmlFor="ambiguity">歧义等级 {ambiguity}</label>
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
              <label htmlFor="risk">风险等级 {risk}</label>
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
            预览路由
          </button>
          <ErrorNotice message={error} />
        </section>
        <section className="card">
          <h3>路由决定</h3>
          <pre className="code-panel result-output">
            {decision ? JSON.stringify(decision, null, 2) : "等待预览"}
          </pre>
        </section>
      </div>
    </>
  );
}

function Models() {
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void Promise.all([
      routerFetch<{ data: ModelRecord[] }>("/api/v1/models"),
      routerFetch<Quota>("/api/v1/quota"),
    ])
      .then(([catalog, snapshot]) => {
        setModels(catalog.data);
        setQuota(snapshot);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "模型目录读取失败"));
  }, []);
  return (
    <>
      <PageHeading
        eyebrow="Codex 运行时"
        title="模型与额度"
        copy="模型目录只包含 Codex Luna、Terra 和 Sol"
      />
      <ErrorNotice message={error} />
      <section className="metrics">
        <article className="metric">
          <small>额度使用</small>
          <strong>{quota?.usedPercent == null ? "—" : `${quota.usedPercent}%`}</strong>
          <span className="muted">窗口 {quota?.windowDurationMinutes ?? "—"} 分钟</span>
        </article>
        <article className="metric">
          <small>重置时间</small>
          <strong className="metric-date">{formatDate(quota?.resetsAt ?? null)}</strong>
          <span className="muted">套餐 {quota?.planType ?? "未知"}</span>
        </article>
        <article className="metric">
          <small>额度数据源</small>
          <strong className="metric-date">
            {quota?.source === "app-server" ? "Codex App Server" : "暂不可用"}
          </strong>
          <span className="muted">通过 Worker 本地 App Server 读取</span>
        </article>
      </section>
      <section className="grid-3 console-section">
        {models.map((model) => (
          <article className="card" key={model.id}>
            <span className="card-index">{model.alias.toUpperCase()}</span>
            <h3>{model.id}</h3>
            <p className="muted">{MODEL_PURPOSE_LABEL[model.alias] ?? model.purpose}</p>
            <span className="pill">Codex</span>
          </article>
        ))}
      </section>
      <section className="card console-section">
        <h3>计量口径</h3>
        <dl className="detail-list">
          <div>
            <dt>窗口百分比</dt>
            <dd>Codex App Server 返回的当前额度窗口已使用比例，不代表单项任务成本</dd>
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
    </>
  );
}

function Keys() {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [name, setName] = useState("AIALRA Agent");
  const [createdKey, setCreatedKey] = useState("");
  const [rateLimit, setRateLimit] = useState(60);
  const [expiresInDays, setExpiresInDays] = useState("30");
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
          scopes: ["jobs:read", "jobs:write", "quota:read"],
          rateLimitPerMinute: rateLimit,
          expiresAt:
            expiresInDays === "never"
              ? null
              : new Date(Date.now() + Number(expiresInDays) * 86_400_000).toISOString(),
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
                <td colSpan={8} className="muted">
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
              <dd>任务读取、任务写入、额度读取</dd>
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

function Records({ kind }: { kind: "audit" | "retention" }) {
  const [records, setRecords] = useState<Array<AuditRecord | DeletionReceipt>>([]);
  const [error, setError] = useState("");
  const definition = useMemo(
    () =>
      kind === "audit"
        ? {
            title: "审计记录",
            copy: "记录登录身份触发的密钥、任务、审批和管理变更",
            path: "/api/v1/audit?limit=100",
          }
        : {
            title: "删除回执",
            copy: "确认任务正文和元数据保留任务已经执行",
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
                    <td>{audit.actorId ?? "系统保留任务"}</td>
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

export function ConsoleApp({ section = "overview" }: { section?: string }) {
  const content =
    section === "overview" ? (
      <Overview />
    ) : section === "playground" ? (
      <Playground />
    ) : section === "jobs" ? (
      <Jobs />
    ) : section === "routing" ? (
      <Routing />
    ) : section === "models" ? (
      <Models />
    ) : section === "keys" ? (
      <Keys />
    ) : section === "audit" ? (
      <Records kind="audit" />
    ) : section === "retention" ? (
      <Records kind="retention" />
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
