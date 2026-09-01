import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Response } from "express";

import { CreateJobRequestSchema } from "@aialra/contracts";

import type { AuthenticatedRequest } from "../common/api-key.guard.js";
import { zodHttpError } from "../common/http-errors.js";
import { RequireScopes } from "../common/scopes.decorator.js";
import { JobsService } from "./jobs.service.js";

@Controller("api/v1/jobs")
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Post()
  @RequireScopes("jobs:write")
  async create(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: { code: "idempotency_key_required", message: "Idempotency-Key is required." },
      });
    }
    const parsed = CreateJobRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw zodHttpError(parsed.error);
    }
    return this.jobs.create(
      parsed.data,
      request.callerId ?? "unknown",
      idempotencyKey ?? null,
      request.executionPolicy,
      request.scopes ?? [],
    );
  }

  @Get()
  @RequireScopes("jobs:read")
  async list(
    @Req() request: AuthenticatedRequest,
    @Query("limit", new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return {
      data: await this.jobs.listForActor(
        request.callerId ?? "unknown",
        request.isAdmin === true,
        limit,
      ),
    };
  }

  @Get(":id")
  @RequireScopes("jobs:read")
  async get(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.jobs.getForActor(id, request.callerId ?? "unknown", request.isAdmin === true);
  }

  @Get(":id/events")
  @RequireScopes("jobs:read")
  async events(
    @Param("id") id: string,
    @Query("after", new ParseIntPipe({ optional: true })) after?: number,
    @Query("stream") stream?: string,
    @Headers("accept") accept?: string,
    @Req() request?: AuthenticatedRequest,
    @Res({ passthrough: true }) response?: Response,
  ) {
    if (stream === "true" || accept?.includes("text/event-stream")) {
      response?.status(200);
      response?.setHeader("Content-Type", "text/event-stream");
      response?.setHeader("Cache-Control", "no-cache, no-transform");
      response?.setHeader("Connection", "keep-alive");
      response?.flushHeaders();
      for await (const event of this.jobs.streamEventsForActor(
        id,
        request?.callerId ?? "unknown",
        request?.isAdmin === true,
        after,
      )) {
        response?.write(`id: ${event.sequence}\n`);
        response?.write(`event: ${event.type}\n`);
        response?.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response?.end();
      return;
    }
    return {
      data: await this.jobs.eventsForActor(
        id,
        request?.callerId ?? "unknown",
        request?.isAdmin === true,
        after,
      ),
    };
  }

  @Post(":id/cancel")
  @RequireScopes("jobs:write")
  async cancel(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: { code: "idempotency_key_required", message: "Idempotency-Key is required." },
      });
    }
    return this.jobs.cancelForActor(id, request.callerId ?? "unknown", request.isAdmin === true);
  }

  @Post(":id/approvals")
  @RequireScopes("approvals:write")
  async decideApproval(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: { code: "idempotency_key_required", message: "Idempotency-Key is required." },
      });
    }
    const value = body as { decision?: string; reason?: string };
    if (value.decision !== "approved" && value.decision !== "denied") {
      throw new BadRequestException({
        error: { code: "invalid_approval", message: "Decision must be approved or denied." },
      });
    }
    return this.jobs.decideApproval(
      id,
      value.decision,
      request.callerId ?? "unknown",
      value.reason ?? "",
      request.isAdmin === true,
    );
  }
}

@Controller("api/v1/batches")
export class BatchesController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Post()
  @RequireScopes("jobs:write")
  async create(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: { code: "idempotency_key_required", message: "Idempotency-Key is required." },
      });
    }
    const value = Array.isArray(body) ? body : (body as { requests?: unknown[] })?.requests;
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
      throw new BadRequestException({
        error: {
          code: "invalid_batch",
          message: "A batch must contain between 1 and 100 requests.",
        },
      });
    }
    const requests = value.map((item, index) => {
      const parsed = CreateJobRequestSchema.safeParse(item);
      if (!parsed.success) {
        throw new BadRequestException({
          error: {
            code: "invalid_batch_item",
            message: `Batch item ${index} is invalid.`,
            details: parsed.error.flatten(),
          },
        });
      }
      return parsed.data;
    });
    return {
      data: await this.jobs.createBatch(
        requests,
        request.callerId ?? "unknown",
        idempotencyKey ?? null,
        request.executionPolicy,
        request.scopes ?? [],
      ),
    };
  }
}
