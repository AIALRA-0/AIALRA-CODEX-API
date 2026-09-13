import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";

import Ajv from "ajv";

import {
  type CreateJobRequestInput,
  type ExecutionChannel,
  type ExecutionPolicy,
  type Job,
  type JobEvent,
  parseLegacyValidationCheck,
  permissionProfileForPreset,
  type RouteDecision,
  type SessionThread,
  TaskContractSchema,
} from "@aialra/contracts";
import type { JobRepository } from "@aialra/persistence";
import { DEFAULT_ROUTING_POLICY, selectRoute } from "@aialra/router";
import { requestHash } from "@aialra/security";

import type { JobQueue } from "../queue/job-queue.js";
import { QuotaService } from "../quota/quota.service.js";
import { JOB_QUEUE, JOB_REPOSITORY } from "../tokens.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"]);
const RESTRICTED_EXECUTION_POLICY: ExecutionPolicy = {
  defaultPreset: "restricted",
  allowedPresets: ["restricted"],
};

@Injectable()
export class JobsService {
  constructor(
    @Inject(JOB_REPOSITORY) private readonly repository: JobRepository,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(QuotaService) private readonly quotaService: QuotaService,
  ) {}

  private async assertRoutableModel(
    modelId: string,
    provider: RouteDecision["provider"],
  ): Promise<void> {
    const settings = await this.repository.listModelSettings();
    const setting = settings.find((candidate) => candidate.modelId === modelId);
    if (setting?.enabled === false || (!setting && !modelId.startsWith("gpt-5.6-"))) {
      throw new ConflictException({
        error: { code: "model_disabled", message: "该模型尚未在 Router 中启用。" },
      });
    }
    const catalog = await this.repository.latestModelCatalog();
    const providerModels = (catalog?.models ?? []).filter(
      (candidate) => (candidate.provider ?? "codex") === provider,
    );
    if (
      providerModels.length > 0 &&
      !providerModels.some((candidate) => candidate.id === modelId && candidate.available)
    ) {
      throw new ConflictException({
        error: { code: "model_unavailable", message: "当前执行通道无法使用该模型。" },
      });
    }
  }

  async create(
    input: CreateJobRequestInput,
    callerId: string,
    idempotencyKey: string | null,
    executionPolicy: ExecutionPolicy = RESTRICTED_EXECUTION_POLICY,
    callerScopes: string[] = [],
    allowedExecutionChannels: ExecutionChannel[] = callerScopes.includes("admin") ||
    callerScopes.includes("chatgpt:web")
      ? ["codex", "chatgpt_web"]
      : ["codex"],
  ): Promise<Job> {
    if (process.env.JOB_SUBMISSION_ENABLED === "false") {
      throw new BadRequestException({
        error: {
          code: "codex_adapter_unavailable",
          message: "Codex Worker 尚未通过登录与隔离探针，当前暂停接单。",
        },
      });
    }
    const parsedTask = TaskContractSchema.parse(input.task);
    if (
      !callerScopes.includes("admin") &&
      !allowedExecutionChannels.includes(parsedTask.executionChannel)
    ) {
      throw new ForbiddenException({
        error: {
          code: "execution_channel_not_allowed",
          message:
            parsedTask.executionChannel === "codex"
              ? "当前 API 密钥只允许调用聊天通道，不能创建 Codex 任务。"
              : "当前 API 密钥只允许调用 Codex 通道，不能创建 ChatGPT 网页任务。",
        },
      });
    }
    if (parsedTask.executionChannel === "chatgpt_web") {
      if (process.env.CHATGPT_WEB_ADAPTER_ENABLED !== "true") {
        throw new ConflictException({
          error: { code: "chatgpt_web_disabled", message: "ChatGPT 网页通道尚未启用。" },
        });
      }
      if (!callerScopes.includes("admin") && !callerScopes.includes("chatgpt:web")) {
        throw new ForbiddenException({
          error: {
            code: "chatgpt_web_scope_required",
            message: "当前 API 密钥没有 ChatGPT 网页通道权限。",
          },
        });
      }
      const webStatus = await this.repository.readChatGptWebStatus();
      const webAccounts = await this.repository.listChatGptWebAccounts();
      const cooldownRetryAfter = webStatus.cooldownUntil
        ? Math.max(0, Math.ceil((new Date(webStatus.cooldownUntil).getTime() - Date.now()) / 1_000))
        : Math.max(1, webStatus.retryAfter ?? 1);
      const recoveryRetryAfter = webStatus.lastSubmissionAt
        ? Math.max(
            1,
            90 - Math.floor((Date.now() - new Date(webStatus.lastSubmissionAt).getTime()) / 1_000),
          )
        : 90;
      const cooldownActive =
        webStatus.rateLimitState === "cooldown" &&
        (!webStatus.cooldownUntil || cooldownRetryAfter > 0);
      const recoveryProbeActive = webStatus.rateLimitState === "recovery_probe";
      const qualifiedAccounts = webAccounts.filter(
        (account) =>
          account.enabled &&
          account.qualified &&
          !["disabled", "quarantined", "login_required"].includes(account.state),
      );
      const allAccountsCoolingDown =
        webAccounts.length > 0 &&
        qualifiedAccounts.length > 0 &&
        qualifiedAccounts.every(
          (account) =>
            account.rateLimitState === "cooldown" &&
            account.lastRateLimitAt &&
            account.retryAfter != null &&
            new Date(account.lastRateLimitAt).getTime() + account.retryAfter * 1_000 > Date.now(),
        );
      if (cooldownActive || recoveryProbeActive || allAccountsCoolingDown) {
        const accountRetryAfter = allAccountsCoolingDown
          ? Math.max(
              1,
              Math.ceil(
                (Math.min(
                  ...qualifiedAccounts.map(
                    (account) =>
                      new Date(account.lastRateLimitAt!).getTime() + account.retryAfter! * 1_000,
                  ),
                ) -
                  Date.now()) /
                  1_000,
              ),
            )
          : 0;
        const retryAfter = Math.max(
          1,
          recoveryProbeActive ? recoveryRetryAfter : 0,
          cooldownActive ? cooldownRetryAfter : 0,
          accountRetryAfter,
        );
        throw new HttpException(
          {
            error: {
              code: "chatgpt_rate_limited",
              message: "ChatGPT 网页通道正在等待限流恢复或恢复探针完成",
              retryAfter,
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (webAccounts.length > 0 && !qualifiedAccounts.length) {
        throw new ConflictException({
          error: {
            code: "chatgpt_web_circuit_open",
            message: "没有已通过单探针且可用的网页账号。",
          },
        });
      }
    }
    const preset = parsedTask.permissions.preset ?? executionPolicy.defaultPreset;
    if (!executionPolicy.allowedPresets.includes(preset)) {
      throw new ForbiddenException({
        error: {
          code: "permission_ceiling_exceeded",
          message: "请求的执行权限超过当前 API 密钥允许的范围。",
        },
      });
    }
    const task = {
      ...parsedTask,
      permissions: permissionProfileForPreset(preset),
    };
    for (const rule of task.validation.acceptanceTests) {
      if (!parseLegacyValidationCheck(rule)) {
        throw new BadRequestException({
          error: {
            code: "invalid_validation_rule",
            message: "旧版验收规则只接受 equals: 或 contains: 前缀。",
          },
        });
      }
    }
    if (task.validation.responseSchema) {
      try {
        new Ajv({ strict: false }).compile(task.validation.responseSchema);
      } catch (error) {
        throw new BadRequestException({
          error: {
            code: "invalid_response_schema",
            message: error instanceof Error ? error.message : "JSON Schema 无效。",
          },
        });
      }
    }
    let stickyThread: SessionThread | null = null;
    if (task.sessionKey) {
      stickyThread = await this.repository.findSessionThread(task.sessionKey);
      if (!stickyThread || new Date(stickyThread.expiresAt).getTime() <= Date.now()) {
        throw new ConflictException({
          error: {
            code: "session_expired",
            message: "会话线程不存在或已到期，请开始新的对话。",
          },
        });
      }
      if (stickyThread.callerId !== callerId) {
        throw new ForbiddenException({
          error: {
            code: "session_access_denied",
            message: "不能继续使用其他调用者的会话线程。",
          },
        });
      }
    }
    const route: RouteDecision = stickyThread
      ? {
          provider: "codex",
          model: stickyThread.model,
          effort: stickyThread.effort,
          policyVersion: DEFAULT_ROUTING_POLICY.version,
          reasonCode: "session_sticky",
          sticky: true,
        }
      : selectRoute(
          task,
          task.executionChannel === "chatgpt_web" ? null : await this.quotaService.read(),
        );
    await this.assertRoutableModel(route.model, route.provider);
    const normalizedInput = { ...input, task };
    const hash = requestHash(normalizedInput);
    if (idempotencyKey) {
      const existing = await this.repository.findByIdempotency(callerId, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== hash) {
          throw new ConflictException({
            error: {
              code: "idempotency_conflict",
              message: "The idempotency key was already used with a different request.",
            },
          });
        }
        return existing;
      }
    }

    const now = new Date();
    const job: Job = {
      id: randomUUID(),
      status: "accepted",
      requestHash: hash,
      idempotencyKey,
      callerId,
      task,
      route,
      output: null,
      errorCode: null,
      errorMessage: null,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        codexCredits: null,
        apiEquivalentUsd: null,
        quotaUsedPercentBefore: null,
        quotaUsedPercentAfter: null,
        quotaWindowDeltaPercent: null,
        allocatedSubscriptionUsd: null,
        measurementStatus: route.provider === "codex" ? "measured" : "unavailable",
        subscriptionChannel: route.provider === "codex" ? "codex" : "chatgpt_pro_web",
        sourceCount: null,
        durationMs: null,
      },
      validation: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    };

    const created = await this.repository.create(job);
    if (created.id !== job.id) {
      if (created.requestHash !== hash) {
        throw new ConflictException({
          error: {
            code: "idempotency_conflict",
            message: "The idempotency key was already used with a different request.",
          },
        });
      }
      return created;
    }
    await this.repository.appendAudit({
      id: randomUUID(),
      actorId: callerId,
      action: "job.created",
      resourceType: "job",
      resourceId: job.id,
      metadata: { taskKind: job.task.taskKind, dataClassification: job.task.dataClassification },
      createdAt: now.toISOString(),
    });
    await this.repository.appendEvent(job.id, "status", { status: "accepted" });
    if (preset === "confirm") {
      await this.repository.transitionJob(
        job.id,
        { status: "awaiting_approval" },
        {
          id: randomUUID(),
          actorId: callerId,
          action: "job.awaiting_approval",
          resourceType: "job",
          resourceId: job.id,
          metadata: { permissionPreset: preset },
          createdAt: new Date().toISOString(),
        },
      );
      await this.repository.appendEvent(job.id, "approval", {
        status: "requested",
        permissionPreset: preset,
        writes: true,
        network: true,
      });
    } else {
      await this.repository.transitionJob(
        job.id,
        { status: "queued" },
        {
          id: randomUUID(),
          actorId: callerId,
          action: "job.queued",
          resourceType: "job",
          resourceId: job.id,
          metadata: { permissionPreset: preset },
          createdAt: new Date().toISOString(),
        },
      );
      await this.queue.enqueue(job.id, job.task.executionChannel, job.task.deadlineMs);
    }
    return (await this.repository.findById(job.id)) as Job;
  }

  async createBatch(
    requests: CreateJobRequestInput[],
    callerId: string,
    batchKey: string | null,
    executionPolicy: ExecutionPolicy = RESTRICTED_EXECUTION_POLICY,
    callerScopes: string[] = [],
    allowedExecutionChannels?: ExecutionChannel[],
  ): Promise<Job[]> {
    return Promise.all(
      requests.map((request, index) =>
        this.create(
          request,
          callerId,
          batchKey ? `${batchKey}:${index}` : null,
          executionPolicy,
          callerScopes,
          allowedExecutionChannels,
        ),
      ),
    );
  }

  async list(limit = 100): Promise<Job[]> {
    return this.repository.list(limit);
  }

  async listForActor(actorId: string, isAdmin: boolean, limit = 100): Promise<Job[]> {
    const jobs = await this.repository.list(limit);
    return isAdmin ? jobs : jobs.filter((job) => job.callerId === actorId);
  }

  private assertAccess(job: Job, actorId: string, isAdmin: boolean): void {
    if (!isAdmin && job.callerId !== actorId) {
      throw new ForbiddenException({
        error: { code: "job_access_denied", message: "You cannot access this job." },
      });
    }
  }

  async retryAfterFor(job: Job): Promise<number | undefined> {
    if (job.errorCode !== "chatgpt_rate_limited") return undefined;
    const now = Date.now();
    const status = await this.repository.readChatGptWebStatus();
    const accounts = await this.repository.listChatGptWebAccounts();
    const accountDelays = accounts
      .filter(
        (account) => account.enabled && account.qualified && account.rateLimitState === "cooldown",
      )
      .map((account) =>
        account.lastRateLimitAt && account.retryAfter != null
          ? Math.ceil(
              (new Date(account.lastRateLimitAt).getTime() + account.retryAfter * 1_000 - now) /
                1_000,
            )
          : 0,
      )
      .filter((delay) => delay > 0);
    const globalDelay =
      status.rateLimitState === "cooldown"
        ? status.cooldownUntil
          ? Math.ceil((new Date(status.cooldownUntil).getTime() - now) / 1_000)
          : (status.retryAfter ?? 1)
        : 0;
    return Math.max(1, globalDelay, accountDelays.length ? Math.min(...accountDelays) : 0);
  }

  async get(id: string): Promise<Job> {
    const job = await this.repository.findById(id);
    if (!job) {
      throw new NotFoundException({
        error: { code: "job_not_found", message: "The requested job does not exist." },
      });
    }
    return job;
  }

  async getForActor(id: string, actorId: string, isAdmin: boolean): Promise<Job> {
    const job = await this.get(id);
    this.assertAccess(job, actorId, isAdmin);
    return job;
  }

  async events(id: string, afterSequence = -1): Promise<JobEvent[]> {
    await this.get(id);
    return this.repository.events(id, afterSequence);
  }

  async eventsForActor(
    id: string,
    actorId: string,
    isAdmin: boolean,
    afterSequence = -1,
  ): Promise<JobEvent[]> {
    await this.getForActor(id, actorId, isAdmin);
    return this.repository.events(id, afterSequence);
  }

  async cancel(id: string): Promise<Job> {
    const job = await this.get(id);
    if (TERMINAL_STATUSES.has(job.status)) {
      return job;
    }
    if (job.status !== "awaiting_approval") {
      throw new ConflictException({
        error: {
          code: "invalid_approval_state",
          message: "只有等待授权的调用可以批准或拒绝。",
        },
      });
    }
    await this.queue.cancel(id);
    return this.repository.transitionJob(
      id,
      { status: "cancelled" },
      {
        id: randomUUID(),
        actorId: job.callerId,
        action: "job.cancelled",
        resourceType: "job",
        resourceId: id,
        metadata: {},
        createdAt: new Date().toISOString(),
      },
    );
  }

  async cancelForActor(id: string, actorId: string, isAdmin: boolean): Promise<Job> {
    await this.getForActor(id, actorId, isAdmin);
    const updated = await this.cancel(id);
    await this.repository.appendAudit({
      id: randomUUID(),
      actorId,
      action: "job.cancelled.by_actor",
      resourceType: "job",
      resourceId: id,
      metadata: { ownerAccess: !isAdmin },
      createdAt: new Date().toISOString(),
    });
    return updated;
  }

  async decideApproval(
    id: string,
    decision: "approved" | "denied",
    actorId: string,
    reason: string,
    isAdmin = false,
  ): Promise<Job> {
    const job = await this.getForActor(id, actorId, isAdmin);
    if (TERMINAL_STATUSES.has(job.status)) {
      return job;
    }
    const events = await this.repository.events(id);
    const priorDecision = events.find(
      (event) =>
        event.type === "approval" &&
        (event.data.status === "approved" || event.data.status === "denied"),
    );
    if (priorDecision) {
      return job;
    }
    await this.repository.appendEvent(id, "approval", {
      status: decision,
      actorId,
      reason: reason.slice(0, 1_000),
    });
    await this.repository.appendAudit({
      id: randomUUID(),
      actorId,
      action: `approval.${decision}`,
      resourceType: "job",
      resourceId: id,
      metadata: { reason: reason.slice(0, 1_000) },
      createdAt: new Date().toISOString(),
    });
    if (decision === "denied") {
      return this.repository.transitionJob(
        id,
        {
          status: "cancelled",
          errorCode: "approval_denied",
          errorMessage: "The requested execution permission was denied.",
        },
        {
          id: randomUUID(),
          actorId,
          action: "job.approval_denied",
          resourceType: "job",
          resourceId: id,
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      );
    }
    await this.repository.transitionJob(
      id,
      { status: "queued", errorCode: null, errorMessage: null },
      {
        id: randomUUID(),
        actorId,
        action: "job.queued_after_approval",
        resourceType: "job",
        resourceId: id,
        metadata: {},
        createdAt: new Date().toISOString(),
      },
    );
    const approvedJob = await this.get(id);
    await this.queue.enqueue(id, approvedJob.task.executionChannel, approvedJob.task.deadlineMs);
    return this.get(id);
  }

  async preview(taskInput: unknown) {
    const parsed = TaskContractSchema.parse(taskInput);
    const task = {
      ...parsed,
      permissions: permissionProfileForPreset(parsed.permissions.preset ?? "restricted"),
    };
    const quota = task.executionChannel === "chatgpt_web" ? null : await this.quotaService.read();
    try {
      const route = selectRoute(task, quota);
      await this.assertRoutableModel(route.model, route.provider);
      return route;
    } catch (error) {
      const code = error instanceof Error ? error.message : "routing_rejected";
      throw new ConflictException({
        error: {
          code,
          message: "The current routing policy rejected this execution channel or model.",
        },
      });
    }
  }

  async waitForTerminal(id: string, deadlineMs: number): Promise<Job> {
    const expires = Date.now() + deadlineMs;
    while (Date.now() < expires) {
      const job = await this.get(id);
      if (TERMINAL_STATUSES.has(job.status)) {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.get(id);
  }

  async *streamEvents(
    id: string,
    afterSequence = -1,
    deadlineMs = 3_600_000,
    signal?: AbortSignal,
  ): AsyncGenerator<JobEvent> {
    const expires = Date.now() + deadlineMs;
    let cursor = afterSequence;
    while (Date.now() < expires && !signal?.aborted) {
      const events = await this.events(id, cursor);
      for (const event of events) {
        cursor = event.sequence;
        yield event;
      }
      const job = await this.get(id);
      if (TERMINAL_STATUSES.has(job.status)) {
        // The worker can commit its final output between the event read and
        // the status read. Drain once more after observing the terminal state.
        for (const event of await this.events(id, cursor)) {
          yield event;
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async *streamEventsForActor(
    id: string,
    actorId: string,
    isAdmin: boolean,
    afterSequence = -1,
    deadlineMs = 3_600_000,
  ): AsyncGenerator<JobEvent> {
    await this.getForActor(id, actorId, isAdmin);
    yield* this.streamEvents(id, afterSequence, deadlineMs);
  }
}
