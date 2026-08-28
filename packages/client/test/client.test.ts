import { describe, expect, it, vi } from "vitest";

import type { ModelRouterError } from "../src/index.js";
import { ModelRouterClient } from "../src/index.js";

describe("ModelRouterClient", () => {
  it("waits until a job reaches a terminal state", async () => {
    let reads = 0;
    const fetchImplementation = vi.fn(async () => {
      reads += 1;
      return new Response(
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000000",
          status: reads > 1 ? "succeeded" : "running",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new ModelRouterClient({
      baseUrl: "https://router.example.invalid",
      apiKey: "amr_test",
      fetchImplementation: fetchImplementation as typeof fetch,
    });

    const job = await client.waitForJob("00000000-0000-4000-8000-000000000000", {
      // Keep the assertion deterministic when the full monorepo test matrix runs in parallel on CI.
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    });

    expect(job.status).toBe("succeeded");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("sends scoped authentication and idempotency headers", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ id: "job" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new ModelRouterClient({
      baseUrl: "https://router.internal/",
      apiKey: "test-key",
      fetchImplementation,
    });

    await client.createJob({ task: { objective: "test" } as never, metadata: {} }, "once");

    const init = fetchImplementation.mock.calls[0]?.[1] as RequestInit;
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe("https://router.internal/api/v1/jobs");
    expect(init.headers).toMatchObject({
      authorization: "Bearer test-key",
      "idempotency-key": "once",
    });
  });

  it("returns structured API errors", async () => {
    const client = new ModelRouterClient({
      baseUrl: "https://router.internal",
      apiKey: "test-key",
      fetchImplementation: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "invalid_request", message: "Invalid" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch,
    });

    await expect(client.getQuota()).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
    } satisfies Partial<ModelRouterError>);
  });
});
