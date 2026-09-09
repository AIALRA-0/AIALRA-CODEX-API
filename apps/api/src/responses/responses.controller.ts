import { Body, Controller, Inject, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";

import { ResponsesRequestSchema, TaskContractSchema } from "@aialra/contracts";

import type { AuthenticatedRequest } from "../common/api-key.guard.js";
import { zodHttpError } from "../common/http-errors.js";
import { RequireScopes } from "../common/scopes.decorator.js";
import { openEventStream } from "../common/sse.js";
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
    const persistentDeepResearch =
      executionChannel === "chatgpt_web" && chatgptMode === "deep_research";
    const conversationMode =
      value.aialra?.conversation_mode ??
      (persistentDeepResearch ? "persistent_per_request" : "temporary_per_request");
    const temporaryChat = value.aialra?.temporary_chat ?? !persistentDeepResearch;
    const deadlineMs =
      value.aialra?.deadline_ms ??
      (executionChannel === "chatgpt_web"
        ? chatgptMode === "deep_research"
          ? 3_600_000
          : 600_000
        : 120_000);
    const taskResult = TaskContractSchema.safeParse({
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
              conversationMode,
              temporaryChat,
              personalized: persistentDeepResearch,
              persistenceAcknowledged:
                value.aialra?.deep_research_persistence_acknowledged ?? false,
              requireSources: value.aialra?.require_sources ?? chatgptMode !== "chat",
              thinkingDepth: value.aialra?.thinking_depth,
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
    if (!taskResult.success) throw zodHttpError(taskResult.error);
    const task = taskResult.data;
    const job = await this.jobs.create(
      { task, metadata: value.metadata },
      request.callerId ?? "unknown",
      idempotencyKey,
      request.executionPolicy,
      request.scopes ?? [],
    );
    response.setHeader(
      "X-AIALRA-Data-Retention",
      persistentDeepResearch ? "persistent_chat_history" : "temporary_or_provider_managed",
    );

    if (value.stream) {
      const stream = openEventStream(response);
      try {
        let emittedText = false;
        const created = {
          id: `resp_${job.id}`,
          object: "response",
          status: "in_progress",
          model: job.task.model,
          metadata: {
            job_id: job.id,
            session_key: job.task.sessionKey ?? null,
            conversation_mode: job.task.chatgptWeb?.conversationMode ?? null,
            data_retention: persistentDeepResearch
              ? "persistent_chat_history"
              : "temporary_or_provider_managed",
          },
        };
        response.write(`event: response.created\n`);
        response.write(`data: ${JSON.stringify(created)}\n\n`);
        for await (const event of this.jobs.streamEvents(
          job.id,
          -1,
          job.task.deadlineMs + 5_000,
          stream.signal,
        )) {
          if (stream.signal.aborted) return;
          if (event.type === "output.delta") {
            emittedText = true;
            response.write("event: response.output_text.delta\n");
            response.write(
              `data: ${JSON.stringify({ type: "response.output_text.delta", delta: event.data.delta ?? "" })}\n\n`,
            );
          } else if (event.type === "tool") {
            response.write("event: response.tool_event\n");
            response.write(`data: ${JSON.stringify(event.data)}\n\n`);
          }
        }
        if (stream.signal.aborted) return;
        const completed = await this.jobs.get(job.id);
        if (completed.status === "succeeded" && !emittedText) {
          const delta =
            typeof completed.output === "string"
              ? completed.output
              : JSON.stringify(completed.output ?? "");
          response.write(
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`,
          );
        }
        const finalEvent =
          completed.status === "succeeded" ? "response.completed" : "response.failed";
        const retryAfter =
          completed.errorCode === "chatgpt_rate_limited"
            ? await this.jobs.retryAfterFor(completed)
            : undefined;
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
                ? {
                    code: completed.errorCode,
                    message: completed.errorMessage,
                    ...(retryAfter !== undefined ? { retryAfter } : {}),
                  }
                : null,
            },
          })}\n\n`,
        );
        response.write("data: [DONE]\n\n");
        response.end();
      } finally {
        stream.close();
      }
      return;
    }

    const completed = await this.jobs.waitForTerminal(job.id, job.task.deadlineMs);
    const retryAfter =
      completed.errorCode === "chatgpt_rate_limited"
        ? await this.jobs.retryAfterFor(completed)
        : undefined;
    if (retryAfter !== undefined) response.setHeader("Retry-After", String(retryAfter));
    response.status(
      retryAfter !== undefined
        ? 429
        : completed.status === "queued" || completed.status === "running"
          ? 202
          : 200,
    );
    response.json({
      id: `resp_${completed.id}`,
      object: "response",
      status: completed.status,
      model: completed.route?.model ?? completed.task.model,
      output: completed.output,
      error: completed.errorCode
        ? {
            code: completed.errorCode,
            message: completed.errorMessage,
            ...(retryAfter !== undefined ? { retryAfter } : {}),
          }
        : null,
      usage: completed.usage,
      metadata: {
        job_id: completed.id,
        session_key: completed.task.sessionKey ?? null,
        conversation_mode: completed.task.chatgptWeb?.conversationMode ?? null,
        data_retention: persistentDeepResearch
          ? "persistent_chat_history"
          : "temporary_or_provider_managed",
      },
    });
  }
}
