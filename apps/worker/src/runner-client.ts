import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import {
  ChatGptWebFailurePhaseSchema,
  ModelCatalogSnapshotSchema,
  QuotaSnapshotSchema,
  type ModelCatalogSnapshot,
  type QuotaSnapshot,
  type ChatGptWebDiagnosticSummary,
  type ChatGptWebFailurePhase,
  UsageLedgerSchema,
} from "@aialra/contracts";
import type {
  ModelProvider,
  ProviderEvent,
  ProviderInvocation,
  ProviderResult,
} from "@aialra/providers";
import { redact } from "@aialra/security";

type RunnerFrame =
  | { type: "event"; event: ProviderEvent }
  | { type: "result"; result: ProviderResult }
  | {
      type: "error";
      error: {
        code: string;
        message: string;
        failurePhase?: ChatGptWebFailurePhase | null;
        diagnosticSummary?: ChatGptWebDiagnosticSummary | null;
      };
    };

export type RunnerSubmissionState = "not_submitted" | "submitted" | "uncertain";

const SUBMITTED_PHASES = new Set<ChatGptWebFailurePhase>([
  "submitted",
  "user_echo_verified",
  "generating",
  "stabilizing",
  "resetting",
]);

function submissionStateForError(
  code: string,
  lastPhase: ChatGptWebFailurePhase | null,
): RunnerSubmissionState {
  if (lastPhase && SUBMITTED_PHASES.has(lastPhase)) return "submitted";
  // These errors are emitted before the bridge accepts a message. Unknown
  // errors remain uncertain so the pool never guesses that a retry is safe.
  if (
    [
      "chatgpt_browser_unavailable",
      "chatgpt_login_required",
      "chatgpt_verification_required",
      "chatgpt_rate_limited",
      "chatgpt_page_not_ready",
    ].includes(code)
  ) {
    return "not_submitted";
  }
  return "uncertain";
}

export class RunnerProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly submissionState: RunnerSubmissionState,
    readonly failurePhase: ChatGptWebFailurePhase | null = null,
    readonly diagnosticSummary: ChatGptWebDiagnosticSummary | null = null,
    readonly retryAfter: number | null = null,
  ) {
    super(`${code}:${redact(message)}`);
    this.name = "RunnerProviderError";
  }
}

export class RunnerClientProvider implements ModelProvider {
  readonly workspaceMode = "provider" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    readonly name: "codex" | "chatgpt_web" = "codex",
  ) {}

  private headers(headers: Record<string, string> = {}): Record<string, string> {
    return { ...headers, authorization: `Bearer ${this.apiToken}` };
  }

  async invoke(invocation: ProviderInvocation): Promise<ProviderResult> {
    if (!invocation.jobId) throw new Error("runner_job_id_required");
    let response: Response;
    try {
      response = await fetch(new URL("/invoke", this.baseUrl), {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          jobId: invocation.jobId,
          attempt: invocation.attempt ?? 1,
          task: invocation.task,
          route: invocation.route,
        }),
        signal: invocation.signal,
      });
    } catch (error) {
      throw new RunnerProviderError(
        "runner_transport_error",
        error instanceof Error ? error.message : String(error),
        "uncertain",
      );
    }
    if (!response.ok || !response.body) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string; retryAfter?: number };
      } | null;
      const code = payload?.error?.code ?? `runner_unavailable:${response.status}`;
      throw new RunnerProviderError(
        code,
        payload?.error?.message ?? code,
        response.ok ? "uncertain" : "not_submitted",
        null,
        null,
        typeof payload?.error?.retryAfter === "number" ? payload.error.retryAfter : null,
      );
    }

    let result: ProviderResult | null = null;
    let lastPhase: ChatGptWebFailurePhase | null = null;
    const lines = createInterface({
      input: Readable.fromWeb(response.body as never),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as RunnerFrame;
        if (frame.type === "event") {
          const phase =
            frame.event.data.kind === "chatgpt_web"
              ? ChatGptWebFailurePhaseSchema.safeParse(frame.event.data.phase)
              : null;
          if (phase?.success) lastPhase = phase.data;
          await invocation.onEvent?.(frame.event);
        } else if (frame.type === "result") {
          result = { ...frame.result, usage: UsageLedgerSchema.parse(frame.result.usage) };
        } else {
          throw new RunnerProviderError(
            frame.error.code,
            frame.error.message,
            submissionStateForError(frame.error.code, lastPhase),
            frame.error.failurePhase ?? lastPhase,
            frame.error.diagnosticSummary ?? null,
          );
        }
      }
    } catch (error) {
      if (error instanceof RunnerProviderError) throw error;
      throw new RunnerProviderError(
        "runner_transport_error",
        error instanceof Error ? error.message : String(error),
        "uncertain",
        lastPhase,
      );
    }
    if (!result) {
      throw new RunnerProviderError(
        "runner_missing_result",
        "The runner closed without a result.",
        "uncertain",
        lastPhase,
      );
    }
    return result;
  }
}

export class RunnerQuotaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
  ) {}

  private headers(): Record<string, string> {
    return { accept: "application/json", authorization: `Bearer ${this.apiToken}` };
  }

  async read(): Promise<QuotaSnapshot> {
    const response = await fetch(new URL("/quota", this.baseUrl), {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`runner_quota_unavailable:${response.status}`);
    return QuotaSnapshotSchema.parse(await response.json());
  }

  async listModels(): Promise<ModelCatalogSnapshot> {
    const response = await fetch(new URL("/models", this.baseUrl), {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`runner_models_unavailable:${response.status}`);
    return ModelCatalogSnapshotSchema.parse(await response.json());
  }

  async readHealth(): Promise<Record<string, unknown>> {
    const response = await fetch(new URL("/healthz", this.baseUrl), {
      headers: this.headers(),
    });
    if (![200, 503].includes(response.status)) {
      throw new Error(`runner_health_unavailable:${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}
