import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RouteDecisionSchema, TaskContractSchema } from "@aialra/contracts";
import { configuredChatGptWebAccountConfigs, InMemoryJobRepository } from "@aialra/persistence";
import type { ProviderEvent, ProviderInvocation } from "@aialra/providers";

import { ChatGptWebPoolProvider } from "../src/chatgpt-web-pool.js";

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
  measurementStatus: "unavailable" as const,
  subscriptionChannel: "chatgpt_pro_web" as const,
  sourceCount: null,
  durationMs: 1,
};

function health(accountId: string): Record<string, unknown> {
  return {
    status: "ready",
    service: "aialra-chatgpt-web-bridge",
    accountId,
    enabled: true,
    sandboxVerified: true,
    extensionConnected: true,
    pageReady: true,
    authenticated: true,
    activeTabs: 0,
    slots: [],
    quarantinedTabs: 0,
    adapterVersion: "dom-bridge-v2",
    failureCode: null,
    phase: "idle",
    activeJobId: null,
    activeAttempt: null,
    lastHeartbeatAt: new Date().toISOString(),
    lastFailureCode: null,
    lastResetAt: null,
    lastSubmissionAt: null,
  };
}

function invocation(events: ProviderEvent[] = []): ProviderInvocation {
  return {
    jobId: randomUUID(),
    task: TaskContractSchema.parse({
      objective: "Return a short synthetic marker",
      executionChannel: "chatgpt_web",
      model: "chatgpt-web.auto",
      chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
    }),
    route: RouteDecisionSchema.parse({
      provider: "chatgpt_web",
      model: "chatgpt-web.auto",
      effort: "low",
      policyVersion: "test",
      reasonCode: "test",
      sticky: true,
    }),
    onEvent: async (event) => {
      events.push(event);
    },
  };
}

function response(frames: unknown[], status = 200): Response {
  return new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
    status,
    headers: { "content-type": "application/x-ndjson" },
  });
}

async function readyRepository() {
  const repository = new InMemoryJobRepository();
  const configs = configuredChatGptWebAccountConfigs("a,b").map((config) => ({
    ...config,
    bridgeUrl: `http://${config.accountId}.test`,
  }));
  await repository.syncChatGptWebAccounts(configs);
  for (const accountId of ["account-a", "account-b"]) {
    await repository.updateChatGptWebAccount(accountId, {
      enabled: true,
      qualified: true,
      state: "ready",
      authenticated: true,
      extensionConnected: true,
      pageReady: true,
      sandboxVerified: true,
    });
  }
  return { repository, configs };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatGptWebPoolProvider", () => {
  it("assigns concurrent tasks to different accounts", async () => {
    const { repository, configs } = await readyRepository();
    let resolveInvocations: () => void = () => undefined;
    const bothInvocations = new Promise<void>((resolve) => {
      resolveInvocations = resolve;
    });
    let invocationCount = 0;
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      const accountId = url.includes("account-b") ? "account-b" : "account-a";
      if (url.endsWith("/healthz")) return new Response(JSON.stringify(health(accountId)));
      invocationCount += 1;
      if (invocationCount === 2) resolveInvocations();
      await bothInvocations;
      return response([
        {
          type: "event",
          event: { type: "tool", data: { kind: "chatgpt_web", phase: "submitted" } },
        },
        {
          type: "result",
          result: { output: "POOL_OK", outputText: "POOL_OK", threadId: null, usage },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const pool = new ChatGptWebPoolProvider(repository, configs, "synthetic-token", true);
    await pool.syncAccounts();

    const events: ProviderEvent[] = [];
    const first = invocation(events);
    const second = invocation(events);
    const [firstResult, secondResult] = await Promise.all([
      pool.invoke(first),
      pool.invoke(second),
    ]);

    expect(firstResult.outputText).toBe("POOL_OK");
    expect(secondResult.outputText).toBe("POOL_OK");
    expect(
      events
        .filter((event) => event.data.kind === "chatgpt_web_account_assigned")
        .map((event) => event.data.accountId)
        .sort(),
    ).toEqual(["account-a", "account-b"]);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/invoke")),
    ).toHaveLength(2);
    expect(
      (await repository.listChatGptWebAccounts()).every((account) => account.activeJobId === null),
    ).toBe(true);
  });

  it("fails over only when the first account rejected the request before submission", async () => {
    const { repository, configs } = await readyRepository();
    let accountAInvocations = 0;
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      const accountId = url.includes("account-b") ? "account-b" : "account-a";
      if (url.endsWith("/healthz")) return new Response(JSON.stringify(health(accountId)));
      if (accountId === "account-a" && accountAInvocations++ === 0) {
        return response([
          {
            type: "error",
            error: { code: "chatgpt_browser_unavailable", message: "not ready" },
          },
        ]);
      }
      return response([
        {
          type: "result",
          result: { output: "FAILOVER_OK", outputText: "FAILOVER_OK", threadId: null, usage },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const pool = new ChatGptWebPoolProvider(repository, configs, "synthetic-token", true);
    await pool.syncAccounts();

    await expect(pool.invoke(invocation())).resolves.toMatchObject({ outputText: "FAILOVER_OK" });
    expect(
      fetchMock.mock.calls
        .filter(([input]) => String(input).endsWith("/invoke"))
        .map(([input]) => (String(input).includes("account-b") ? "account-b" : "account-a")),
    ).toEqual(["account-a", "account-b"]);
  });

  it("never fails over after the bridge has reported submission", async () => {
    const { repository, configs } = await readyRepository();
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      const accountId = url.includes("account-b") ? "account-b" : "account-a";
      if (url.endsWith("/healthz")) return new Response(JSON.stringify(health(accountId)));
      return response([
        {
          type: "event",
          event: { type: "tool", data: { kind: "chatgpt_web", phase: "submitted" } },
        },
        {
          type: "error",
          error: {
            code: "chatgpt_page_generation_blank",
            message: "assistant output was blank",
            failurePhase: "generating",
          },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const pool = new ChatGptWebPoolProvider(repository, configs, "synthetic-token", true);
    await pool.syncAccounts();

    await expect(pool.invoke(invocation())).rejects.toMatchObject({
      code: "chatgpt_page_generation_blank",
      submissionState: "submitted",
      accountId: "account-a",
    });
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/invoke")),
    ).toHaveLength(1);
  });
});
