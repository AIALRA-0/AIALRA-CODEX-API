import { Controller, Get, Inject, ParseIntPipe, Query, Req } from "@nestjs/common";

import type { JobRepository } from "@aialra/persistence";

import type { AuthenticatedRequest } from "../common/api-key.guard.js";
import { RequireScopes } from "../common/scopes.decorator.js";
import { JOB_REPOSITORY } from "../tokens.js";

@Controller("api/v1/threads")
export class ThreadsController {
  constructor(@Inject(JOB_REPOSITORY) private readonly repository: JobRepository) {}

  @Get()
  @RequireScopes("jobs:read")
  async list(
    @Req() request: AuthenticatedRequest,
    @Query("limit", new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return {
      data: await this.repository.listSessionThreads(
        request.callerId ?? "unknown",
        request.isAdmin === true,
        limit,
      ),
    };
  }
}
