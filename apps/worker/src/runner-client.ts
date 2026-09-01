import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import {
  ModelCatalogSnapshotSchema,
  QuotaSnapshotSchema,
  type ModelCatalogSnapshot,
  type QuotaSnapshot,
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
  | { type: "error"; error: { code: string; message: string } };

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
    const response = await fetch(new URL("/invoke", this.baseUrl), {
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
    if (!response.ok || !response.body) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      throw new Error(payload?.error?.code ?? `runner_unavailable:${response.status}`);
    }

    let result: ProviderResult | null = null;
    const lines = createInterface({
      input: Readable.fromWeb(response.body as never),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line) as RunnerFrame;
      if (frame.type === "event") await invocation.onEvent?.(frame.event);
      else if (frame.type === "result") {
        result = { ...frame.result, usage: UsageLedgerSchema.parse(frame.result.usage) };
      } else throw new Error(`${frame.error.code}:${redact(frame.error.message)}`);
    }
    if (!result) throw new Error("runner_missing_result");
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
