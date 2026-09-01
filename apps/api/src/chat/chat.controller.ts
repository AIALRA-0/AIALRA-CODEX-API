import { randomUUID } from "node:crypto";

import { Body, Controller, Inject, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";

import {
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionMessage,
  type ChatCompletionsRequest,
  ChatCompletionsRequestSchema,
  type Job,
  TaskContractSchema,
} from "@aialra/contracts";

import type { AuthenticatedRequest } from "../common/api-key.guard.js";
import { zodHttpError } from "../common/http-errors.js";
import { RequireScopes } from "../common/scopes.decorator.js";
import { JobsService } from "../jobs/jobs.service.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"]);

interface PromptParts {
  objective: string;
}

/**
 * Renders a Chat Completions message list as one task prompt. When the caller
 * continues a persistent Codex thread, only the latest user turn is sent; the
 * thread itself carries the earlier context.
 */
export function chatMessagesToPrompt(
  messages: ChatCompletionMessage[],
  resumeThread: boolean,
): PromptParts {
  const systemParts = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content)
    .filter(Boolean);
  const turns = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (resumeThread) {
    const lastUser = [...turns].reverse().find((message) => message.role === "user");
    if (!lastUser || !lastUser.content.trim()) {
      throw chatMappingError(
        "invalid_request",
        "A resumed conversation must end with a non-empty user message.",
      );
    }
    return { objective: lastUser.content };
  }
  const transcript = turns
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n");
  const objective = [systemParts.join("\n\n"), transcript, "Assistant:"]
    .filter(Boolean)
    .join("\n\n");
  if (!objective.replace("Assistant:", "").trim()) {
    throw chatMappingError("invalid_request", "The messages array does not contain any content.");
  }
  return { objective };
}

function chatMappingError(code: string, message: string): Error & { httpError?: unknown } {
  const error = new Error(message) as Error & { httpError?: unknown };
  error.httpError = { status: 400, body: { error: { code, message } } };
  return error;
}

export function chatCompletionFromJob(job: Job, maxOutputTokens: number): ChatCompletion {
  const content = typeof job.output === "string" ? job.output : JSON.stringify(job.output ?? "");
  const measured = job.usage.measurementStatus !== "unavailable";
  const completion: ChatCompletion = {
    id: `chatcmpl-${job.id}`,
    object: "chat.completion",
    created: Math.floor(new Date(job.createdAt).getTime() / 1_000),
    model: job.route?.model ?? job.task.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: job.usage.outputTokens >= maxOutputTokens ? "length" : "stop",
      },
    ],
    ...(measured
      ? {
          usage: {
            prompt_tokens: job.usage.inputTokens,
            completion_tokens: job.usage.outputTokens,
            total_tokens: job.usage.inputTokens + job.usage.outputTokens,
          },
        }
      : {}),
    aialra: {
      job_id: job.id,
      session_key: job.task.sessionKey ?? null,
      measurement_status: measured ? "measured" : "unavailable",
    },
  };
  return completion;
}

function chunkBase(job: Job): Pick<ChatCompletionChunk, "id" | "object" | "created" | "model"> {
  return {
    id: `chatcmpl-${job.id}`,
    object: "chat.completion.chunk",
    created: Math.floor(new Date(job.createdAt).getTime() / 1_000),
    model: job.route?.model ?? job.task.model,
  };
}

@Controller("v1/chat/completions")
export class ChatCompletionsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Post()
  @RequireScopes("jobs:write")
  async create(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    const parsed = ChatCompletionsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw zodHttpError(parsed.error);
    }
    const value: ChatCompletionsRequest = parsed.data;
    const executionChannel =
      value.aialra?.execution_channel ??
      (value.model.startsWith("chatgpt-web.") ? "chatgpt_web" : "codex");
    const sessionKey = value.aialra?.session_key;
    const chatgptMode = value.aialra?.chatgpt_mode ?? "chat";
    const deadlineMs =
      value.aialra?.deadline_ms ??
      (executionChannel === "chatgpt_web"
        ? chatgptMode === "deep_research"
          ? 3_600_000
          : 600_000
        : 120_000);

    let prompt: PromptParts;
    try {
      prompt = chatMessagesToPrompt(value.messages, Boolean(sessionKey));
    } catch (error) {
      const mapped = (error as { httpError?: { status: number; body: unknown } }).httpError;
      response.status(mapped?.status ?? 400).json(mapped?.body ?? {});
      return;
    }

    const schema =
      value.response_format?.type === "json_schema"
        ? value.response_format.json_schema.schema
        : undefined;
    const objective =
      value.response_format?.type === "json_object"
        ? `${prompt.objective}\n\nRespond with a single valid JSON object and nothing else.`
        : prompt.objective;
    const maxOutputTokens = value.max_completion_tokens ?? value.max_tokens ?? 8_192;
    const task = TaskContractSchema.parse({
      objective,
      taskKind: schema ? "bounded" : "general",
      expectedOutput: "Return the final assistant message for the caller.",
      validation: { responseSchema: schema, checks: [], acceptanceTests: [] },
      permissions: value.aialra?.permission_preset
        ? { preset: value.aialra.permission_preset }
        : undefined,
      model: value.model,
      effort: value.reasoning_effort ?? "medium",
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
      sessionKey,
      sessionMode:
        executionChannel === "chatgpt_web"
          ? "ephemeral"
          : (value.aialra?.session_mode ?? (sessionKey ? "persistent" : "ephemeral")),
      deadlineMs,
      budget: {
        maxOutputTokens,
        maxAttempts: executionChannel === "chatgpt_web" ? 1 : 2,
      },
    });

    const idempotencyKey = request.header("idempotency-key") ?? randomUUID();
    const job = await this.jobs.create(
      { task, metadata: value.metadata ?? {} },
      request.callerId ?? "unknown",
      idempotencyKey,
      request.executionPolicy,
      request.scopes ?? [],
    );

    if (value.stream) {
      await this.stream(job, value, maxOutputTokens, response);
      return;
    }

    const completed = await this.jobs.waitForTerminal(job.id, task.deadlineMs);
    if (!TERMINAL_STATUSES.has(completed.status)) {
      response.status(504).json({
        error: {
          code: "gateway_timeout",
          message: "The call is still running. Poll GET /api/v1/jobs/{id} for the final result.",
          details: { job_id: completed.id },
        },
      });
      return;
    }
    if (completed.status !== "succeeded") {
      response.status(502).json({
        error: {
          code: completed.errorCode ?? "provider_error",
          message: completed.errorMessage ?? "The call did not complete successfully.",
          details: { job_id: completed.id, status: completed.status },
        },
      });
      return;
    }
    response.status(200).json(chatCompletionFromJob(completed, maxOutputTokens));
  }

  private async stream(
    job: Job,
    value: ChatCompletionsRequest,
    maxOutputTokens: number,
    response: Response,
  ): Promise<void> {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const writeChunk = (chunk: ChatCompletionChunk) =>
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    let emittedText = false;

    writeChunk({
      ...chunkBase(job),
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    for await (const event of this.jobs.streamEvents(job.id, -1, job.task.deadlineMs + 5_000)) {
      if (event.type === "output.delta") {
        emittedText = true;
        writeChunk({
          ...chunkBase(job),
          choices: [
            { index: 0, delta: { content: String(event.data.delta ?? "") }, finish_reason: null },
          ],
        });
      }
    }

    const completed = await this.jobs.get(job.id);
    if (
      completed.status === "succeeded" &&
      completed.task.executionChannel === "chatgpt_web" &&
      !emittedText
    ) {
      const content =
        typeof completed.output === "string"
          ? completed.output
          : JSON.stringify(completed.output ?? "");
      writeChunk({
        ...chunkBase(completed),
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      });
    }
    if (completed.status !== "succeeded") {
      response.write(
        `event: error\ndata: ${JSON.stringify({
          error: {
            code:
              completed.errorCode ??
              (TERMINAL_STATUSES.has(completed.status) ? "provider_error" : "gateway_timeout"),
            message: completed.errorMessage ?? "The call did not complete successfully.",
            details: { job_id: completed.id, status: completed.status },
          },
        })}\n\n`,
      );
    }
    writeChunk({
      ...chunkBase(completed),
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason:
            completed.status === "succeeded"
              ? completed.usage.outputTokens >= maxOutputTokens
                ? "length"
                : "stop"
              : null,
        },
      ],
    });
    if (
      value.stream_options?.include_usage &&
      completed.usage.measurementStatus !== "unavailable"
    ) {
      writeChunk({
        ...chunkBase(completed),
        choices: [{ index: 0, delta: {}, finish_reason: null }],
        usage: {
          prompt_tokens: completed.usage.inputTokens,
          completion_tokens: completed.usage.outputTokens,
          total_tokens: completed.usage.inputTokens + completed.usage.outputTokens,
        },
      });
    }
    response.write("data: [DONE]\n\n");
    response.end();
  }
}
