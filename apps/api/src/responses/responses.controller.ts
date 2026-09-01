import { Body, Controller, Inject, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";

import { ResponsesRequestSchema, TaskContractSchema } from "@aialra/contracts";

import type { AuthenticatedRequest } from "../common/api-key.guard.js";
import { zodHttpError } from "../common/http-errors.js";
import { RequireScopes } from "../common/scopes.decorator.js";
import { JobsService } from "../jobs/jobs.service.js";

function inputToText(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

@Controller("v1/responses")
export class ResponsesController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Post()
  @RequireScopes("jobs:write")
  async create(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    const parsed = ResponsesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw zodHttpError(parsed.error);
    }
    const idempotencyKey = request.header("idempotency-key");
    if (!idempotencyKey) {
      response.status(400).json({
        error: { code: "idempotency_key_required", message: "Idempotency-Key is required." },
      });
      return;
    }
    const value = parsed.data;
    const executionChannel =
      value.aialra?.execution_channel ??
      (value.model.startsWith("chatgpt-web.") ? "chatgpt_web" : "codex");
    const chatgptMode = value.aialra?.chatgpt_mode ?? "chat";
    const deadlineMs =
      value.aialra?.deadline_ms ??
      (executionChannel === "chatgpt_web"
        ? chatgptMode === "deep_research"
          ? 3_600_000
          : 600_000
        : 120_000);
    const task = TaskContractSchema.parse({
      objective: [value.instructions, inputToText(value.input)].filter(Boolean).join("\n\n"),
      taskKind: value.text?.format?.type === "json_schema" ? "bounded" : "general",
      expectedOutput: "Return the final response for the caller.",
      validation: {
        responseSchema: value.text?.format?.schema,
        checks: [],
        acceptanceTests: [],
      },
      permissions: value.aialra?.permission_preset
        ? { preset: value.aialra.permission_preset }
        : undefined,
      model: value.model,
      effort: value.reasoning?.effort ?? "medium",
      executionChannel,
      chatgptWeb:
        executionChannel === "chatgpt_web"
          ? {
              mode: chatgptMode,
              conversationMode: value.aialra?.conversation_mode ?? "temporary_per_request",
              temporaryChat: value.aialra?.temporary_chat ?? true,
              personalized: false,
              requireSources: value.aialra?.require_sources ?? chatgptMode !== "chat",
            }
          : undefined,
      sessionKey: value.aialra?.session_key,
      sessionMode:
        executionChannel === "chatgpt_web"
          ? "ephemeral"
          : (value.aialra?.session_mode ??
            (value.aialra?.session_key ? "persistent" : "ephemeral")),
      deadlineMs,
      budget: {
        maxOutputTokens: value.max_output_tokens ?? 8_192,
        maxAttempts: executionChannel === "chatgpt_web" ? 1 : 2,
      },
    });
    const job = await this.jobs.create(
      { task, metadata: value.metadata },
      request.callerId ?? "unknown",
      idempotencyKey,
      request.executionPolicy,
      request.scopes ?? [],
    );

    if (value.stream) {
      response.status(200);
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders();
      const created = {
        id: `resp_${job.id}`,
        object: "response",
        status: "in_progress",
        model: job.task.model,
        metadata: { job_id: job.id, session_key: job.task.sessionKey ?? null },
      };
      response.write(`event: response.created\n`);
      response.write(`data: ${JSON.stringify(created)}\n\n`);
      for await (const event of this.jobs.streamEvents(job.id, -1, job.task.deadlineMs + 5_000)) {
        if (event.type === "output.delta") {
          response.write("event: response.output_text.delta\n");
          response.write(
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: event.data.delta ?? "" })}\n\n`,
          );
        } else if (event.type === "tool") {
          response.write("event: response.tool_event\n");
          response.write(`data: ${JSON.stringify(event.data)}\n\n`);
        }
      }
      const completed = await this.jobs.get(job.id);
      const finalEvent =
        completed.status === "succeeded" ? "response.completed" : "response.failed";
      response.write(`event: ${finalEvent}\n`);
      response.write(
        `data: ${JSON.stringify({
          type: finalEvent,
          response: {
            id: `resp_${completed.id}`,
            status: completed.status,
            model: completed.route?.model ?? completed.task.model,
            output: completed.output,
            usage: completed.usage,
            error: completed.errorCode
              ? { code: completed.errorCode, message: completed.errorMessage }
              : null,
          },
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }

    const completed = await this.jobs.waitForTerminal(job.id, job.task.deadlineMs);
    response.status(completed.status === "queued" || completed.status === "running" ? 202 : 200);
    response.json({
      id: `resp_${completed.id}`,
      object: "response",
      status: completed.status,
      model: completed.route?.model ?? completed.task.model,
      output: completed.output,
      error: completed.errorCode
        ? { code: completed.errorCode, message: completed.errorMessage }
        : null,
      usage: completed.usage,
      metadata: { job_id: completed.id, session_key: completed.task.sessionKey ?? null },
    });
  }
}
