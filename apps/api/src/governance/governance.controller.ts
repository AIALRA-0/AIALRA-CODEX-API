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
import { z } from "zod";

import { TaskContractSchema, type RuntimeModel } from "@aialra/contracts";
import type { JobRepository } from "@aialra/persistence";
import { requestHash } from "@aialra/security";

import type { AuthenticatedRequest } from "../common/api-key.guard.js";
import { zodHttpError } from "../common/http-errors.js";
import { RequireScopes } from "../common/scopes.decorator.js";
import { JobsService } from "../jobs/jobs.service.js";
import { QuotaService } from "../quota/quota.service.js";
import { JOB_REPOSITORY } from "../tokens.js";

@Controller("api/v1")
export class GovernanceController {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(JOB_REPOSITORY) private readonly repository: JobRepository,
  ) {}

  private async modelCatalog(): Promise<RuntimeModel[]> {
    const runtime = await this.repository.latestModelCatalog();
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
      return {
        ...(found ?? {
          id,
          displayName,
          available: false,
          hidden: false,
          isDefault: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ["text"],
          discoveredAt: runtime?.fetchedAt ?? new Date(0).toISOString(),
        }),
        displayName,
        enabled: settings.get(id) ?? false,
        creditRate,
        apiRate,
        rateStatus: creditRate && apiRate ? ("available" as const) : ("unavailable" as const),
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
        error: { code: "model_unavailable", message: "当前 Codex 账号无法使用该模型。" },
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

  @Get("usage")
  @RequireScopes("jobs:read")
  async usage() {
    const jobs = await this.jobs.list(500);
    const acceptedTasks = jobs.filter((job) => job.status === "succeeded").length;
    const codexCredits = jobs.reduce((sum, job) => sum + (job.usage.codexCredits ?? 0), 0);
    const apiEquivalentUsd = jobs.reduce(
      (sum, job) => sum + (job.usage.apiEquivalentUsd ?? (job.usage.codexCredits ?? 0) * 0.04),
      0,
    );
    return {
      accepted_tasks: acceptedTasks,
      codex_credits: codexCredits,
      api_equivalent_usd: apiEquivalentUsd,
      credits_per_accepted_task: acceptedTasks ? codexCredits / acceptedTasks : null,
      api_equivalent_usd_per_accepted_task: acceptedTasks ? apiEquivalentUsd / acceptedTasks : null,
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
