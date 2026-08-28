import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";

import {
  type CreateJobRequest,
  type Job,
  type JobEvent,
  TaskContractSchema,
} from "@aialra/contracts";
import type { JobRepository } from "@aialra/persistence";
import { selectRoute } from "@aialra/router";
import { requestHash } from "@aialra/security";

import type { JobQueue } from "../queue/job-queue.js";
import { QuotaService } from "../quota/quota.service.js";
import { JOB_QUEUE, JOB_REPOSITORY } from "../tokens.js";

const TERMINAL_STATUSES = new Set(["succeeded", "needs_review", "failed", "cancelled", "expired"]);

@Injectable()
export class JobsService {
  constructor(
    @Inject(JOB_REPOSITORY) private readonly repository: JobRepository,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(QuotaService) private readonly quotaService: QuotaService,
  ) {}

  private async assertRoutableModel(modelId: string): Promise<void> {
    const settings = await this.repository.listModelSettings();
    const setting = settings.find((candidate) => candidate.modelId === modelId);
    if (setting?.enabled === false || (!setting && !modelId.startsWith("gpt-5.6-"))) {
      throw new ConflictException({
        error: { code: "model_disabled", message: "该模型尚未在 Router 中启用。" },
      });
    }
    const catalog = await this.repository.latestModelCatalog();
    if (
      catalog &&
      !catalog.models.some((candidate) => candidate.id === modelId && candidate.available)
    ) {
      throw new ConflictException({
        error: { code: "model_unavailable", message: "当前 Codex 账号无法使用该模型。" },
      });
    }
  }

  async create(
    input: CreateJobRequest,
    callerId: string,
    idempotencyKey: string | null,
  ): Promise<Job> {
    if (process.env.JOB_SUBMISSION_ENABLED === "false") {
      throw new BadRequestException({
        error: {
          code: "codex_adapter_unavailable",
          message: "Codex Worker 尚未通过登录与隔离探针，当前暂停接单。",
        },
      });
    }
    const task = TaskContractSchema.parse(input.task);
    if (task.permissions.network !== "none") {
      throw new BadRequestException({
        error: {
          code: "unsupported_permission",
          message: "首版尚未启用可验证的域名出口控制，因此拒绝联网任务。",
        },
      });
    }
    if (task.sessionKey) {
      throw new BadRequestException({
        error: {
          code: "unsupported_parameter",
          message: "安全清理模式不保留 Codex 会话，因此暂不支持 sessionKey。",
        },
      });
    }
    const route = selectRoute(task, await this.quotaService.read());
    await this.assertRoutableModel(route.model);
    const hash = requestHash(input);
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
      route: null,
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
      },
      validation: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    };

    await this.repository.create(job);
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
    await this.repository.transitionJob(
      job.id,
      { status: "queued" },
      {
        id: randomUUID(),
        actorId: callerId,
        action: "job.queued",
        resourceType: "job",
        resourceId: job.id,
        metadata: {},
        createdAt: new Date().toISOString(),
      },
    );
    const approvalRequired =
      (job.task.permissions.filesystem === "write" &&
        job.task.permissions.requireApprovalForWrites) ||
      (job.task.permissions.network === "allowlist" &&
        job.task.permissions.requireApprovalForExternalActions);
    if (approvalRequired) {
      await this.repository.appendEvent(job.id, "approval", {
        status: "requested",
        writes: job.task.permissions.filesystem === "write",
        network: job.task.permissions.network === "allowlist",
        allowedHosts: job.task.permissions.allowedHosts,
      });
    } else {
      await this.queue.enqueue(job.id);
    }
    return (await this.repository.findById(job.id)) as Job;
  }

  async createBatch(
    requests: CreateJobRequest[],
    callerId: string,
    batchKey: string | null,
  ): Promise<Job[]> {
    return Promise.all(
      requests.map((request, index) =>
        this.create(request, callerId, batchKey ? `${batchKey}:${index}` : null),
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
          status: "needs_review",
          errorCode: "approval_denied",
          errorMessage: "The requested elevated operation was denied.",
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
    await this.queue.enqueue(id);
    return this.get(id);
  }

  async preview(taskInput: unknown) {
    const task = TaskContractSchema.parse(taskInput);
    const quota = await this.quotaService.read();
    try {
      const route = selectRoute(task, quota);
      await this.assertRoutableModel(route.model);
      return route;
    } catch (error) {
      const code = error instanceof Error ? error.message : "routing_rejected";
      throw new ConflictException({
        error: { code, message: "The current Codex quota policy rejected this automatic route." },
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
  ): AsyncGenerator<JobEvent> {
    const expires = Date.now() + deadlineMs;
    let cursor = afterSequence;
    while (Date.now() < expires) {
      const events = await this.events(id, cursor);
      for (const event of events) {
        cursor = event.sequence;
        yield event;
      }
      const job = await this.get(id);
      if (TERMINAL_STATUSES.has(job.status)) {
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
