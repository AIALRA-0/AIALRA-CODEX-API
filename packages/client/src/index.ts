import type {
  CreateJobRequest,
  Job,
  JobEvent,
  QuotaSnapshot,
  ResponsesRequest,
  RouteDecision,
  TaskContract,
} from "@aialra/contracts";

export type { components, operations, paths } from "./generated.js";

export interface ModelRouterClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImplementation?: typeof fetch;
}

export class ModelRouterError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ModelRouterClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: ModelRouterClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string; details?: unknown };
      };
      throw new ModelRouterError(
        response.status,
        body.error?.code ?? "http_error",
        body.error?.message ?? response.statusText,
        body.error?.details,
      );
    }
    return (await response.json()) as T;
  }

  async createJob(request: CreateJobRequest, idempotencyKey: string): Promise<Job> {
    return this.request(
      "/api/v1/jobs",
      { method: "POST", body: JSON.stringify(request) },
      idempotencyKey,
    );
  }

  async createBatch(requests: CreateJobRequest[], idempotencyKey: string): Promise<Job[]> {
    const result = await this.request<{ data: Job[] }>(
      "/api/v1/batches",
      { method: "POST", body: JSON.stringify({ requests }) },
      idempotencyKey,
    );
    return result.data;
  }

  async listJobs(limit = 100): Promise<Job[]> {
    const result = await this.request<{ data: Job[] }>(`/api/v1/jobs?limit=${limit}`);
    return result.data;
  }

  async getJob(id: string): Promise<Job> {
    return this.request(`/api/v1/jobs/${encodeURIComponent(id)}`);
  }

  async waitForJob(
    id: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<Job> {
    const terminal = new Set(["succeeded", "needs_review", "failed", "cancelled", "expired"]);
    const expires = Date.now() + (options.timeoutMs ?? 120_000);
    while (Date.now() < expires) {
      const job = await this.getJob(id);
      if (terminal.has(job.status)) {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 500));
    }
    throw new ModelRouterError(
      408,
      "client_wait_timeout",
      "The job did not finish before the client timeout.",
    );
  }

  async cancelJob(id: string, idempotencyKey = crypto.randomUUID()): Promise<Job> {
    return this.request(
      `/api/v1/jobs/${encodeURIComponent(id)}/cancel`,
      { method: "POST" },
      idempotencyKey,
    );
  }

  async getJobEvents(id: string, after = -1): Promise<JobEvent[]> {
    const result = await this.request<{ data: JobEvent[] }>(
      `/api/v1/jobs/${encodeURIComponent(id)}/events?after=${after}`,
    );
    return result.data;
  }

  async getQuota(): Promise<QuotaSnapshot> {
    return this.request("/api/v1/quota");
  }

  async previewRoute(task: TaskContract): Promise<RouteDecision> {
    return this.request("/api/v1/routes/preview", {
      method: "POST",
      body: JSON.stringify({ task }),
    });
  }

  async createResponse(request: ResponsesRequest, idempotencyKey: string): Promise<unknown> {
    return this.request(
      "/v1/responses",
      { method: "POST", body: JSON.stringify({ ...request, stream: false }) },
      idempotencyKey,
    );
  }

  async *streamResponse(
    request: ResponsesRequest,
    idempotencyKey: string,
  ): AsyncGenerator<{ event: string; data: unknown }> {
    const response = await this.fetchImplementation(`${this.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ ...request, stream: true }),
    });
    if (!response.ok || !response.body) {
      throw new ModelRouterError(response.status, "stream_error", await response.text());
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        buffer += value;
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event =
            frame
              .split("\n")
              .find((line) => line.startsWith("event: "))
              ?.slice(7) ?? "message";
          const dataText = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (!dataText || dataText === "[DONE]") {
            continue;
          }
          yield { event, data: JSON.parse(dataText) };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
