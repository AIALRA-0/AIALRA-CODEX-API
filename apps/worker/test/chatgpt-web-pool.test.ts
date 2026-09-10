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
  it.each(["temporary_chat_verified", "submitted", "generating"])(
    "preserves ordinary-chat qualification only for verified pre-send mode absence: %s",
    async (failurePhase) => {
      const { repository, configs } = await readyRepository();
      await repository.updateChatGptWebAccount("account-a", { priority: 100 });
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: URL | RequestInfo) => {
          const url = String(input);
          if (url.endsWith("/healthz"))
            return Response.json(health(url.includes("account-b") ? "account-b" : "account-a"));
          calls += 1;
          return response([
            {
              type: "event",
              event: { type: "tool", data: { kind: "chatgpt_web", phase: failurePhase } },
            },
            {
              type: "error",
              error: {
                code: "chatgpt_mode_unavailable",
                message: "mode unavailable",
                failurePhase,
              },
            },
          ]);
        }),
      );
      const pool = new ChatGptWebPoolProvider(repository, configs, "synthetic-token", true);
      await pool.syncAccounts();
      await expect(pool.invoke(invocation())).rejects.toMatchObject({
        code: "chatgpt_mode_unavailable",
      });
      expect(calls).toBe(1);
      const account = (await repository.listChatGptWebAccounts()).find(
        (item) => item.accountId === "account-a",
      )!;
      expect(account.activeJobId).toBeNull();
      expect(account.qualified).toBe(failurePhase === "temporary_chat_verified");
      if (failurePhase === "temporary_chat_verified") expect(account.lastSubmissionAt).toBeNull();
    },
  );
  function depthCatalog(depths: string[]) {
    return {
      source: "chatgpt-web",
      fetchedAt: new Date().toISOString(),
      models: [
        {
          id: "chatgpt-web.auto",
          displayName: "ChatGPT web",
          provider: "chatgpt_web",
          available: true,
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          webThinkingDepths: depths,
          defaultWebThinkingDepth: depths[0] ?? null,
          inputModalities: ["text"],
          creditRate: null,
          apiRate: null,
          rateStatus: "unavailable",
          discoveredAt: new Date().toISOString(),
        },
      ],
    };
  }

  it("merges actual account depths and dispatches only to an account that supports the selection", async () => {
    const { repository, configs } = await readyRepository();
    await repository.updateChatGptWebAccount("account-a", { priority: 100 });
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = String(input);
        const id = url.includes("account-b") ? "account-b" : "account-a";
        if (url.endsWith("/healthz")) return Response.json(health(id));
        if (url.endsWith("/models"))
          return Response.json(
            depthCatalog(id === "account-a" ? ["Standard"] : ["Standard", "Heavy"]),
          );
        sent.push(id);
        return response([
          { type: "result", result: { output: "OK", outputText: "OK", threadId: null, usage } },
        ]);
      }),
    );
    const pool = new ChatGptWebPoolProvider(repository, configs, "synthetic-token", true);
    await pool.syncAccounts();
    expect((await pool.listModels()).models[0]?.webThinkingDepths).toEqual(["Standard", "Heavy"]);
    const task = invocation();
    task.task.chatgptWeb!.thinkingDepth = "Heavy";
    await expect(pool.invoke(task)).resolves.toMatchObject({ outputText: "OK" });
    expect(sent).toEqual(["account-b"]);
    expect(
      (await repository.listChatGptWebAccounts()).find(
        (account) => account.accountId === "account-a",
      )?.qualified,
    ).toBe(true);
  });

  it("does not submit or leak a lease when every account lacks a requested depth", async () => {
    const { repository, configs } = await readyRepository();
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/healthz")) return Response.json(health("synthetic"));
        if (url.endsWith("/models")) return Response.json(depthCatalog(["Standard"]));
        sent.push(url);
        throw new Error("Unexpected submission");
      }),
    );
    const pool = new ChatGptWebPoolProvider(repository, configs, "synthetic-token", true);
    await pool.syncAccounts();
    const task = invocation();
    task.task.chatgptWeb!.thinkingDepth = "Missing";
    await expect(pool.invoke(task)).rejects.toMatchObject({
      code: "chatgpt_thinking_depth_unavailable",
      submissionState: "not_submitted",
    });
    expect(sent).toEqual([]);
    expect(
      (await repository.listChatGptWebAccounts()).every(
        (account) => !account.activeJobId && account.qualified,
      ),
    ).toBe(true);
  });

  it("prefers the primary account but lends overflow to another idle account", async () => {
    const { repository } = await readyRepository();
    await repository.updateChatGptWebAccount("account-a", {
      priority: 100,
      lastSubmissionAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const first = await repository.acquireChatGptWebAccountLease(
      randomUUID(),
      ["account-a", "account-b"],
      new Date(),
      900_000,
    );
    const second = await repository.acquireChatGptWebAccountLease(
      randomUUID(),
      ["account-a", "account-b"],
      new Date(),
      900_000,
    );
    expect(first?.accountId).toBe("account-a");
    expect(second?.accountId).toBe("account-b");
  });

  it("does not let an unauthenticated account mark the healthy pool unavailable", async () => {
    const { repository, configs } = await readyRepository();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const isA = String(input).includes("account-a");
        return new Response(
          JSON.stringify({
            ...health(isA ? "account-a" : "account-b"),
            authenticated: !isA,
            pageReady: !isA,
          }),
        );
      }),
    );
    const pool = new ChatGptWebPoolProvider(repository, configs, "synthetic-token", true);
    await pool.syncAccounts();
    expect(await pool.readHealth()).toMatchObject({
      status: "ready",
      authenticated: true,
      pageReady: true,
      effectiveConcurrency: 1,
    });
  });
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

  it("fails a source-required task once without quarantining the healthy account", async () => {
    const { repository, configs } = await readyRepository();
    await repository.updateChatGptWebAccount("account-a", { priority: 100 });
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      const accountId = url.includes("account-b") ? "account-b" : "account-a";
      if (url.endsWith("/healthz")) return Response.json(health(accountId));
      return response([
        {
          type: "event",
          event: { type: "tool", data: { kind: "chatgpt_web", phase: "submitted" } },
        },
        {
          type: "error",
          error: {
            code: "chatgpt_sources_missing",
            message: "answer had no public source",
            failurePhase: "stabilizing",
          },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const pool = new ChatGptWebPoolProvider(repository, configs, "synthetic-token", true);
    await pool.syncAccounts();

    await expect(pool.invoke(invocation())).rejects.toMatchObject({
      code: "chatgpt_sources_missing",
      submissionState: "submitted",
      accountId: "account-a",
    });
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/invoke")),
    ).toHaveLength(1);
    expect(await repository.findChatGptWebAccount("account-a")).toMatchObject({
      state: "ready",
      qualified: true,
      activeJobId: null,
      lastFailureCode: "chatgpt_sources_missing",
    });
  });

  it("restores a qualified account after a transient browser restart", async () => {
    const { repository, configs } = await readyRepository();
    await repository.updateChatGptWebAccount("account-a", { lastProbePassed: true });
    let healthReads = 0;
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (!url.endsWith("/healthz")) return response([]);
      healthReads += 1;
      if (healthReads === 1) {
        return new Response(
          JSON.stringify({
            ...health("account-a"),
            pageReady: false,
            authenticated: false,
            failureCode: null,
          }),
        );
      }
      return new Response(JSON.stringify(health("account-a")));
    });
    vi.stubGlobal("fetch", fetchMock);
    const pool = new ChatGptWebPoolProvider(repository, configs, "synthetic-token", true);

    await pool.syncAccounts();
    expect(await repository.findChatGptWebAccount("account-a")).toMatchObject({
      qualified: false,
      state: "login_required",
      lastProbePassed: true,
    });

    await pool.refreshHealth();
    expect(await repository.findChatGptWebAccount("account-a")).toMatchObject({
      qualified: true,
      state: "ready",
      lastProbePassed: true,
    });
  });

  it("restores an idle authenticated account after a post-submission quarantine", async () => {
    const { repository, configs } = await readyRepository();
    await repository.updateChatGptWebAccount("account-a", {
      qualified: false,
      state: "quarantined",
      lastProbePassed: true,
      lastFailureCode: "runner_transport_error",
      failurePhase: "generating",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const accountId = String(input).includes("account-b") ? "account-b" : "account-a";
        return Response.json({
          ...health(accountId),
          pending: 0,
          slots: [
            {
              slotId: randomUUID(),
              state: "idle",
              submitted: false,
              quarantinedUntil: null,
              updatedAt: new Date().toISOString(),
            },
          ],
        });
      }),
    );
    const pool = new ChatGptWebPoolProvider(repository, configs, "synthetic-token", true);

    await pool.syncAccounts();

    expect(await repository.findChatGptWebAccount("account-a")).toMatchObject({
      qualified: true,
      state: "ready",
      lastProbePassed: true,
      activeJobId: null,
    });
  });

  it("does not restore a quarantined account while the bridge still owns an old task", async () => {
    const { repository, configs } = await readyRepository();
    await repository.updateChatGptWebAccount("account-a", {
      qualified: false,
      state: "quarantined",
      lastProbePassed: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const accountId = String(input).includes("account-b") ? "account-b" : "account-a";
        return Response.json({
          ...health(accountId),
          phase: accountId === "account-a" ? "generating" : "idle",
          activeJobId: accountId === "account-a" ? "0190abcd-0000-7000-8000-000000000099" : null,
          pending: accountId === "account-a" ? 1 : 0,
        });
      }),
    );
    const pool = new ChatGptWebPoolProvider(repository, configs, "synthetic-token", true);

    await pool.syncAccounts();

    expect(await repository.findChatGptWebAccount("account-a")).toMatchObject({
      qualified: false,
      state: "quarantined",
    });
  });
});
