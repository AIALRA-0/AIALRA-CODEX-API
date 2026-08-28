import { Body, Controller, Get, Inject, ParseIntPipe, Post, Query } from "@nestjs/common";

import { MODEL_CATALOG, TaskContractSchema } from "@aialra/contracts";
import type { JobRepository } from "@aialra/persistence";

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

  @Get("models")
  @RequireScopes("jobs:read")
  models() {
    return { data: MODEL_CATALOG };
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
