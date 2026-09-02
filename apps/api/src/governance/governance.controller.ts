import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ChatGptWebAccountPlanSchema,
  ChatGptWebQualificationRunSchema,
  ChatGptWebQualificationSuiteSchema,
  TaskContractSchema,
  type ChatGptWebQualificationItem,
  type ChatGptWebAccount,
  type RuntimeModel,
} from "@aialra/contracts";
import type { JobRepository } from "@aialra/persistence";
import { requestHash } from "@aialra/security";

import type { AuthenticatedRequest } from "../common/api-key.guard.js";
import { zodHttpError } from "../common/http-errors.js";
import { RequireScopes } from "../common/scopes.decorator.js";
import { JobsService } from "../jobs/jobs.service.js";
import type { JobQueue } from "../queue/job-queue.js";
import { QuotaService } from "../quota/quota.service.js";
import { JOB_QUEUE, JOB_REPOSITORY } from "../tokens.js";

function qualificationRunId(actorId: string, idempotencyKey: string): string {
  const bytes = createHash("sha256")
    .update(`${actorId}\0${idempotencyKey}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function qualificationItems(suite: z.infer<typeof ChatGptWebQualificationSuiteSchema>) {
  const definitions =
    suite === "readiness"
      ? []
      : suite === "single_probe"
        ? [["chat-1", "chat"] as const]
        : suite === "chat_3"
          ? Array.from({ length: 3 }, (_, index) => [`chat-${index + 1}`, "chat"] as const)
          : suite === "chat_10"
            ? Array.from({ length: 10 }, (_, index) => [`chat-${index + 1}`, "chat"] as const)
            : suite === "deep_2"
              ? Array.from(
                  { length: 2 },
                  (_, index) => [`deep-${index + 1}`, "deep_research"] as const,
                )
              : [
                  ...Array.from(
                    { length: 4 },
                    (_, index) => [`chat-${index + 1}`, "chat"] as const,
                  ),
                  ...Array.from(
                    { length: 4 },
                    (_, index) => [`search-${index + 1}`, "search"] as const,
                  ),
                  ...Array.from(
                    { length: 2 },
                    (_, index) => [`deep-${index + 1}`, "deep_research"] as const,
                  ),
                ];
  return definitions.map(([name, mode], index): ChatGptWebQualificationItem => ({
    index: index + 1,
    name,
    mode,
    status: "pending",
    durationMs: null,
    outputLength: null,
    outputSha256: null,
    sourceCount: null,
    errorCode: null,
    submittedCount: 0,
    recoveryCount: 0,
    ownershipMatched: null,
    temporaryChatVerified: false,
  }));
}

function publicAccount(account: ChatGptWebAccount & { bridgeUrl?: string }): ChatGptWebAccount {
  const safe = { ...account } as Record<string, unknown>;
  delete safe.bridgeUrl;
  return safe as ChatGptWebAccount;
}

@Controller("api/v1")
export class GovernanceController {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(JOB_REPOSITORY) private readonly repository: JobRepository,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  private async modelCatalog(): Promise<RuntimeModel[]> {
    const runtime = await this.repository.latestModelCatalog();
    const webStatus = await this.repository.readChatGptWebStatus();
    const settings = new Map(
      (await this.repository.listModelSettings()).map((setting) => [
        setting.modelId,
        setting.enabled,
      ]),
    );
    const discovered = new Map((runtime?.models ?? []).map((model) => [model.id, model]));
    const known = [
      ["gpt-5.6-sol", "GPT-5.6 Sol"],
      ["gpt-5.6-terra", "GPT-5.6 Terra"],
      ["gpt-5.6-luna", "GPT-5.6 Luna"],
      ["gpt-5.5", "GPT-5.5"],
      ["gpt-5.4", "GPT-5.4"],
      ["gpt-5.4-mini", "GPT-5.4 Mini"],
      ["gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"],
    ] as const;
    const allIds = new Set([...known.map(([id]) => id), ...discovered.keys()]);
    const creditRates: Record<string, [number, number, number]> = {
      "gpt-5.6-sol": [100, 10, 500],
      "gpt-5.6-terra": [50, 5, 300],
      "gpt-5.6-luna": [5, 0.5, 30],
      "gpt-5.5": [125, 12.5, 750],
      "gpt-5.4": [62.5, 6.25, 375],
      "gpt-5.4-mini": [18.75, 1.875, 113],
    };
    const apiRates: Record<string, [number, number, number]> = {
      "gpt-5.6-sol": [4, 0.4, 20],
      "gpt-5.6-terra": [2, 0.2, 12],
      "gpt-5.6-luna": [0.2, 0.02, 1.2],
      "gpt-5.5": [5, 0.5, 30],
      "gpt-5.4": [2.5, 0.25, 15],
      "gpt-5.4-mini": [0.75, 0.075, 4.5],
    };
    const rate = (
      values: [number, number, number] | undefined,
      currency: "credits" | "USD",
      source: string,
    ) =>
      values
        ? {
            input: values[0],
            cachedInput: values[1],
            output: values[2],
            currency,
            unit: "million_tokens" as const,
            effectiveDate: "2026-08-25",
            source,
          }
        : null;
    return [...allIds].map((id) => {
      const found = discovered.get(id);
      const displayName =
        known.find(([knownId]) => knownId === id)?.[1] ?? found?.displayName ?? id;
      const creditRate = rate(creditRates[id], "credits", "https://learn.chatgpt.com/docs/pricing");
      const apiRate = rate(
        apiRates[id],
        "USD",
        "https://developers.openai.com/api/docs/models/compare",
      );
      const provider = found?.provider ?? "codex";
      return {
        ...(found ?? {
          id,
          displayName,
          provider: "codex" as const,
          available: false,
          hidden: false,
          isDefault: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ["text"],
          streamingMode: "delta" as const,
          discoveredAt: runtime?.fetchedAt ?? new Date(0).toISOString(),
        }),
        displayName,
        available:
          provider === "chatgpt_web"
            ? Boolean(
                found?.available &&
                webStatus.configuredEnabled &&
                webStatus.effectiveConcurrency > 0 &&
                webStatus.circuitState === "closed" &&
                ["clear", "observation"].includes(webStatus.rateLimitState),
              )
            : (found?.available ?? false),
        enabled: settings.get(id) ?? false,
        creditRate: found?.provider === "chatgpt_web" ? null : creditRate,
        apiRate: found?.provider === "chatgpt_web" ? null : apiRate,
        rateStatus:
          found?.provider !== "chatgpt_web" && creditRate && apiRate
            ? ("available" as const)
            : ("unavailable" as const),
      };
    });
  }

  @Get("models")
  @RequireScopes("jobs:read")
  async models() {
    return { data: await this.modelCatalog() };
  }

  @Patch("models/:modelId")
  @RequireScopes("admin")
  async updateModel(
    @Param("modelId") modelId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: { code: "idempotency_key_required", message: "Idempotency-Key is required." },
      });
    }
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(body);
    if (!parsed.success) throw zodHttpError(parsed.error);
    const model = (await this.modelCatalog()).find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new NotFoundException({ error: { code: "model_not_found", message: "模型不存在。" } });
    }
    if (parsed.data.enabled && !model.available) {
      throw new ConflictException({
        error: { code: "model_unavailable", message: "当前执行通道无法使用该模型。" },
      });
    }
    try {
      const result = await this.repository.setModelEnabledIdempotent(
        modelId,
        parsed.data.enabled,
        request.callerId ?? "unknown",
        idempotencyKey,
        requestHash({ modelId, ...parsed.data }),
      );
      if (!result.replayed) {
        await this.repository.appendAudit({
          id: randomUUID(),
          actorId: request.callerId ?? "unknown",
          action: parsed.data.enabled ? "model.enabled" : "model.disabled",
          resourceType: "model",
          resourceId: modelId,
          metadata: {},
          createdAt: new Date().toISOString(),
        });
      }
      return { ...result.setting, replayed: result.replayed };
    } catch (error) {
      if (error instanceof Error && error.message === "idempotency_conflict") {
        throw new ConflictException({
          error: { code: "idempotency_conflict", message: "该幂等键已用于另一项设置。" },
        });
      }
      throw error;
    }
  }

  @Get("quota")
  @RequireScopes("quota:read")
  async quotaSnapshot() {
    return this.quota.read();
  }

  @Get("chatgpt-web/status")
  @RequireScopes("admin")
  async chatGptWebStatus() {
    const status = await this.repository.readChatGptWebStatus();
    const accounts = (await this.repository.listChatGptWebAccounts()).map(publicAccount);
    const cooldownRetryAfter = status.cooldownUntil
      ? Math.max(0, Math.ceil((new Date(status.cooldownUntil).getTime() - Date.now()) / 1_000))
      : status.retryAfter;
    const recoveryRetryAfter = status.lastSubmissionAt
      ? Math.max(
          1,
          90 - Math.floor((Date.now() - new Date(status.lastSubmissionAt).getTime()) / 1_000),
        )
      : 90;
    return {
      ...status,
      accounts,
      retryAfter:
        status.rateLimitState === "cooldown"
          ? cooldownRetryAfter
          : status.rateLimitState === "recovery_probe"
            ? recoveryRetryAfter
            : null,
    };
  }

  @Get("chatgpt-web/accounts")
  @RequireScopes("admin")
  async chatGptWebAccounts() {
    return { data: (await this.repository.listChatGptWebAccounts()).map(publicAccount) };
  }

  @Patch("chatgpt-web/accounts/:accountId")
  @RequireScopes("admin")
  async updateChatGptWebAccount(
    @Param("accountId") accountId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!/^account-[a-d]$/.test(accountId)) {
      throw new BadRequestException({
        error: { code: "invalid_account_id", message: "账号槽位标识无效。" },
      });
    }
    const parsed = z
      .object({
        label: z.string().trim().min(1).max(64).optional(),
        plan: ChatGptWebAccountPlanSchema.optional(),
        enabled: z.boolean().optional(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw zodHttpError(parsed.error);
    const current = await this.repository.findChatGptWebAccount(accountId);
    if (!current) {
      throw new NotFoundException({
        error: { code: "chatgpt_web_account_not_found", message: "找不到该网页账号槽位。" },
      });
    }
    if (parsed.data.enabled === true && !current.qualified) {
      throw new ConflictException({
        error: {
          code: "chatgpt_account_not_qualified",
          message: "账号必须先通过单探针，才能加入网页任务池。",
        },
      });
    }
    const enabled = parsed.data.enabled ?? current.enabled;
    const reactivatedState =
      current.qualified &&
      current.authenticated &&
      current.extensionConnected &&
      current.pageReady &&
      current.sandboxVerified
        ? ("ready" as const)
        : ("configured" as const);
    const updated = await this.repository.updateChatGptWebAccount(accountId, {
      ...parsed.data,
      ...(parsed.data.enabled === false
        ? { state: "disabled" as const }
        : parsed.data.enabled === true && current.state === "disabled"
          ? { state: reactivatedState }
          : {}),
      enabled,
    });
    await this.repository.appendAudit({
      id: randomUUID(),
      actorId: request.callerId ?? "unknown",
      action:
        parsed.data.enabled === false
          ? "chatgpt_web.account_disabled"
          : "chatgpt_web.account_updated",
      resourceType: "chatgpt_web_account",
      resourceId: accountId,
      metadata: parsed.data,
      createdAt: new Date().toISOString(),
    });
    return publicAccount(updated);
  }

  @Post("chatgpt-web/qualification-runs")
  @RequireScopes("admin")
  async createChatGptWebQualificationRun(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: { code: "idempotency_key_required", message: "Idempotency-Key is required." },
      });
    }
    const parsed = z
      .object({
        suite: ChatGptWebQualificationSuiteSchema,
        accountId: z
          .string()
          .regex(/^account-[a-d]$/)
          .optional(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw zodHttpError(parsed.error);
    const configuredAccounts = await this.repository.listChatGptWebAccounts();
    const accountId =
      parsed.data.accountId ??
      (configuredAccounts.some((account) => account.accountId === "account-a")
        ? "account-a"
        : null);
    if (accountId && !(await this.repository.findChatGptWebAccount(accountId))) {
      throw new NotFoundException({
        error: { code: "chatgpt_web_account_not_found", message: "找不到该网页账号槽位。" },
      });
    }
    const actorId = request.callerId ?? "unknown";
    const id = qualificationRunId(actorId, idempotencyKey);
    const existing = await this.repository.findChatGptWebQualificationRun(id);
    if (existing) {
      if (existing.suite !== parsed.data.suite || existing.accountId !== accountId) {
        throw new ConflictException({
          error: { code: "idempotency_conflict", message: "该幂等键已用于另一种验收套件。" },
        });
      }
      return { ...existing, replayed: true };
    }
    const activeRun = (await this.repository.listChatGptWebQualificationRuns(100)).find(
      (candidate) => candidate.status === "accepted" || candidate.status === "running",
    );
    if (activeRun) {
      throw new ConflictException({
        error: {
          code: "qualification_in_progress",
          message: "已有一组 ChatGPT 网页验收正在运行",
          activeRunId: activeRun.id,
        },
      });
    }
    const now = new Date().toISOString();
    const items = qualificationItems(parsed.data.suite);
    const run = ChatGptWebQualificationRunSchema.parse({
      id,
      accountId,
      suite: parsed.data.suite,
      status: "accepted",
      total: items.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      items,
      errorCode: null,
      createdBy: actorId,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    });
    try {
      await this.repository.createChatGptWebQualificationRun(run);
    } catch {
      const replay = await this.repository.findChatGptWebQualificationRun(id);
      if (replay?.suite === parsed.data.suite) return { ...replay, replayed: true };
      const concurrentRun = (await this.repository.listChatGptWebQualificationRuns(100)).find(
        (candidate) => candidate.status === "accepted" || candidate.status === "running",
      );
      if (concurrentRun) {
        throw new ConflictException({
          error: {
            code: "qualification_in_progress",
            message: "已有一组 ChatGPT 网页验收正在运行",
            activeRunId: concurrentRun.id,
          },
        });
      }
      throw new ConflictException({
        error: { code: "idempotency_conflict", message: "该幂等键发生冲突。" },
      });
    }
    await this.queue.enqueueChatGptWebQualification(id);
    await this.repository.appendAudit({
      id: randomUUID(),
      actorId,
      action: "chatgpt_web.qualification_started",
      resourceType: "chatgpt_web_qualification",
      resourceId: id,
      metadata: { suite: parsed.data.suite, accountId },
      createdAt: now,
    });
    return { ...run, replayed: false };
  }

  @Get("chatgpt-web/qualification-runs")
  @RequireScopes("admin")
  async listChatGptWebQualificationRuns(
    @Query("limit", new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return { data: await this.repository.listChatGptWebQualificationRuns(limit) };
  }

  @Get("chatgpt-web/qualification-runs/:id")
  @RequireScopes("admin")
  async chatGptWebQualificationRun(@Param("id") id: string) {
    const run = await this.repository.findChatGptWebQualificationRun(id);
    if (!run) {
      throw new NotFoundException({
        error: { code: "qualification_run_not_found", message: "找不到这次验收运行。" },
      });
    }
    return run;
  }

  @Get("usage")
  @RequireScopes("jobs:read")
  async usage() {
    const jobs = await this.jobs.list(500);
    const acceptedTasks = jobs.filter((job) => job.status === "succeeded").length;
    const succeededCodexJobs = jobs.filter(
      (job) => job.status === "succeeded" && job.task.executionChannel !== "chatgpt_web",
    );
    const succeededChatGptWebJobs = jobs.filter(
      (job) => job.status === "succeeded" && job.task.executionChannel === "chatgpt_web",
    );
    const codexCredits = succeededCodexJobs.reduce(
      (sum, job) => sum + (job.usage.codexCredits ?? 0),
      0,
    );
    const apiEquivalentUsd = succeededCodexJobs.reduce(
      (sum, job) => sum + (job.usage.apiEquivalentUsd ?? (job.usage.codexCredits ?? 0) * 0.04),
      0,
    );
    return {
      accepted_tasks: acceptedTasks,
      accepted_codex_tasks: succeededCodexJobs.length,
      accepted_chatgpt_web_tasks: succeededChatGptWebJobs.length,
      codex_credits: codexCredits,
      api_equivalent_usd: apiEquivalentUsd,
      credits_per_accepted_task: succeededCodexJobs.length
        ? codexCredits / succeededCodexJobs.length
        : null,
      api_equivalent_usd_per_accepted_task: succeededCodexJobs.length
        ? apiEquivalentUsd / succeededCodexJobs.length
        : null,
      allocated_subscription_usd: jobs.reduce(
        (sum, job) => sum + (job.usage.allocatedSubscriptionUsd ?? 0),
        0,
      ),
    };
  }

  @Post("routes/preview")
  @RequireScopes("jobs:read")
  async preview(@Body() body: unknown) {
    const parsed = TaskContractSchema.safeParse((body as { task?: unknown })?.task ?? body);
    if (!parsed.success) {
      throw zodHttpError(parsed.error);
    }
    return this.jobs.preview(parsed.data);
  }

  @Get("audit")
  @RequireScopes("admin")
  async audit(@Query("limit", new ParseIntPipe({ optional: true })) limit?: number) {
    return { data: await this.repository.listAudit(limit) };
  }

  @Get("retention/receipts")
  @RequireScopes("admin")
  async deletionReceipts(@Query("limit", new ParseIntPipe({ optional: true })) limit?: number) {
    return { data: await this.repository.listDeletionReceipts(limit) };
  }
}
