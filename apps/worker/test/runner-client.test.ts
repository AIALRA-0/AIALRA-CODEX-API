import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInvocation } from "@aialra/providers";

import { RunnerClientProvider } from "../src/runner-client.js";

const invocation = (signal?: AbortSignal): ProviderInvocation => ({
  jobId: "00000000-0000-4000-8000-000000000001",
  attempt: 1,
  task: {
    objective: "Return OK",
    taskKind: "bounded",
    requiredContext: [],
    constraints: [],
    expectedOutput: "OK",
    validation: { checks: [], acceptanceTests: [] },
    dataClassification: "internal",
    permissions: {
      preset: "restricted",
      filesystem: "read",
      network: "none",
      allowedHosts: [],
      requireApprovalForWrites: false,
      requireApprovalForExternalActions: false,
    },
    deadlineMs: 10_000,
    budget: { maxOutputTokens: 128, maxAttempts: 1 },
    sessionMode: "ephemeral",
    executionChannel: "codex",
    model: "luna",
    effort: "low",
    replayable: true,
    ambiguity: 0,
    risk: 0,
  },
  route: {
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    reasonCode: "test",
    policyVersion: "test",
    sticky: true,
  },
  signal,
});

const usage = {
  inputTokens: 1,
  cachedInputTokens: 0,
  outputTokens: 1,
  codexCredits: null,
  apiEquivalentUsd: null,
  quotaUsedPercentBefore: null,
  quotaUsedPercentAfter: null,
  quotaWindowDeltaPercent: null,
  allocatedSubscriptionUsd: null,
  measurementStatus: "measured",
  subscriptionChannel: "codex",
  sourceCount: null,
  durationMs: null,
};

afterEach(() => vi.restoreAllMocks());

describe("RunnerClientProvider", () => {
  it("waits for a busy Runner without counting another upstream attempt", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "runner_busy", retryAfter: 0 } }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          `${JSON.stringify({
            type: "result",
            result: { output: "OK", outputText: "OK", threadId: null, usage },
          })}\n`,
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        ),
      );
    const provider = new RunnerClientProvider("http://runner.test", "token");

    await expect(provider.invoke(invocation(new AbortController().signal))).resolves.toMatchObject({
      outputText: "OK",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body);
  });

  it("keeps a silent long invocation alive without exposing heartbeat frames as model events", async () => {
    const onEvent = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        [
          JSON.stringify({ type: "heartbeat", at: "2026-09-10T20:00:00.000Z" }),
          JSON.stringify({ type: "heartbeat", at: "2026-09-10T20:00:15.000Z" }),
          JSON.stringify({
            type: "result",
            result: { output: "OK", outputText: "OK", threadId: null, usage },
          }),
        ].join("\n") + "\n",
        { status: 200, headers: { "content-type": "application/x-ndjson" } },
      ),
    );
    const provider = new RunnerClientProvider("http://runner.test", "token");

    await expect(provider.invoke({ ...invocation(), onEvent })).resolves.toMatchObject({
      outputText: "OK",
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("reports a busy Runner as definitely not submitted when no deadline signal exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "runner_busy", retryAfter: 1 } }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "1" },
      }),
    );
    const provider = new RunnerClientProvider("http://runner.test", "token");

    await expect(provider.invoke(invocation())).rejects.toMatchObject({
      code: "runner_busy",
      submissionState: "not_submitted",
      retryAfter: 1,
    });
  });

  it("defaults a missing Runner retry hint to one second", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "runner_busy" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new RunnerClientProvider("http://runner.test", "token");

    await expect(provider.invoke(invocation())).rejects.toMatchObject({
      code: "runner_busy",
      retryAfter: 1,
    });
  });
});
