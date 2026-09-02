import {
  ChatGptWebAccountSchema,
  ChatGptWebDiagnosticSummarySchema,
  ChatGptWebFailurePhaseSchema,
  ChatGptWebStatusSchema,
  type ChatGptWebAccount,
  type ChatGptWebStatus,
} from "@aialra/contracts";
import type {
  ChatGptWebAccountConfig,
  ChatGptWebAccountRecord,
  JobRepository,
} from "@aialra/persistence";
import type {
  ModelProvider,
  ProviderInvocation,
  ProviderResult,
  ProviderEvent,
} from "@aialra/providers";

import { RunnerClientProvider, RunnerProviderError, RunnerQuotaClient } from "./runner-client.js";

const ACCOUNT_HEARTBEAT_STALE_MS = 45_000;
const ACCOUNT_LEASE_MS = 15 * 60_000;
const POOL_WAIT_MS = 250;

const HARD_FAILURE_CODES = new Set([
  "chatgpt_login_required",
  "chatgpt_verification_required",
  "chatgpt_ui_changed",
  "chatgpt_page_generation_blank",
  "chatgpt_page_rendering_failed",
  "chatgpt_output_selector_changed",
]);

const SUBMITTED_PHASES = new Set([
  "submitted",
  "user_echo_verified",
  "generating",
  "stabilizing",
  "resetting",
]);

export type ChatGptWebPoolSubmissionState = "not_submitted" | "submitted" | "uncertain";

export class ChatGptWebPoolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly submissionState: ChatGptWebPoolSubmissionState,
    readonly accountId: string | null = null,
    readonly failurePhase: ChatGptWebAccount["failurePhase"] = null,
    readonly diagnosticSummary: ChatGptWebAccount["diagnosticSummary"] = null,
  ) {
    super(`${code}:${message}`);
    this.name = "ChatGptWebPoolError";
  }
}

function safeAccount(account: ChatGptWebAccountRecord): ChatGptWebAccount {
  const publicAccount = { ...account } as Record<string, unknown>;
  delete publicAccount.bridgeUrl;
  return ChatGptWebAccountSchema.parse(publicAccount);
}

function healthString(health: Record<string, unknown>, key: string): string | null {
  return typeof health[key] === "string" ? String(health[key]) : null;
}

function safeFailurePhase(value: unknown): ChatGptWebAccount["failurePhase"] {
  const parsed = ChatGptWebFailurePhaseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeDiagnosticSummary(value: unknown): ChatGptWebAccount["diagnosticSummary"] {
  const parsed = ChatGptWebDiagnosticSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function healthSlots(health: Record<string, unknown>): ChatGptWebStatus["slots"] {
  const states = new Set<ChatGptWebStatus["slots"][number]["state"]>([
    "starting",
    "idle",
    "preparing",
    "ready",
    "submitted",
    "generating",
    "completed",
    "quarantined",
  ]);
  if (!Array.isArray(health.slots)) return [];
  return health.slots.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const slot = value as Record<string, unknown>;
    const slotId = String(slot.slotId ?? "");
    if (!/^[a-f0-9-]{36}$/i.test(slotId)) return [];
    const state = String(slot.state ?? "starting") as ChatGptWebStatus["slots"][number]["state"];
    return [
      {
        slotId,
        state: states.has(state) ? state : "starting",
        submitted: slot.submitted === true,
        quarantinedUntil: typeof slot.quarantinedUntil === "string" ? slot.quarantinedUntil : null,
        updatedAt: typeof slot.updatedAt === "string" ? slot.updatedAt : new Date().toISOString(),
      },
    ];
  });
}

function accountHasActiveLease(account: ChatGptWebAccount, nowMs: number): boolean {
  return Boolean(
    account.activeJobId &&
    account.leaseExpiresAt &&
    new Date(account.leaseExpiresAt).getTime() > nowMs,
  );
}

function accountCooldownActive(account: ChatGptWebAccount, nowMs: number): boolean {
  if (account.rateLimitState !== "cooldown") return false;
  if (!account.lastRateLimitAt || account.retryAfter == null) return true;
  return new Date(account.lastRateLimitAt).getTime() + account.retryAfter * 1_000 > nowMs;
}

function accountEligibleForAdmission(account: ChatGptWebAccount, nowMs: number): boolean {
  return (
    account.enabled &&
    account.qualified &&
    ["ready", "busy"].includes(account.state) &&
    !accountCooldownActive(account, nowMs)
  );
}

function accountEligibleForLease(account: ChatGptWebAccount, nowMs: number): boolean {
  return accountEligibleForAdmission(account, nowMs) && !accountHasActiveLease(account, nowMs);
}

function accountPublicPatch(
  current: ChatGptWebAccount,
  health: Record<string, unknown> | null,
  now: Date,
): Partial<ChatGptWebAccount> {
  if (!health) {
    return {
      state:
        current.enabled && current.qualified && current.state !== "quarantined"
          ? "stale"
          : current.enabled
            ? current.state
            : "disabled",
      lastHeartbeatAt: current.lastHeartbeatAt,
    };
  }
  const authenticated = health.authenticated === true;
  const extensionConnected = health.extensionConnected === true;
  const pageReady = health.pageReady === true;
  const sandboxVerified = health.sandboxVerified === true;
  const failureCode = healthString(health, "failureCode");
  const heartbeat = healthString(health, "lastHeartbeatAt") ?? now.toISOString();
  const heartbeatTime = Date.parse(heartbeat);
  const heartbeatStale =
    !Number.isFinite(heartbeatTime) || now.getTime() - heartbeatTime > ACCOUNT_HEARTBEAT_STALE_MS;
  const hardFailure = failureCode ? HARD_FAILURE_CODES.has(failureCode) : false;
  const rateLimited = failureCode === "chatgpt_rate_limited";
  const cooldownActive = accountCooldownActive(current, now.getTime());
  let state: ChatGptWebAccount["state"];
  let qualified = current.qualified;
  let rateLimitState = current.rateLimitState;
  let retryAfter = current.retryAfter;
  let lastRateLimitAt = current.lastRateLimitAt;
  let consecutiveRateLimits = current.consecutiveRateLimits;

  if (!current.enabled) state = "disabled";
  else if (current.activeJobId) state = "busy";
  else if (rateLimited) {
    state = "cooldown";
    rateLimitState = "cooldown";
    const candidateRetryAfter = Number(health.retryAfter ?? 1_800);
    retryAfter =
      Number.isInteger(candidateRetryAfter) && candidateRetryAfter >= 0
        ? candidateRetryAfter
        : 1_800;
    if (current.rateLimitState !== "cooldown") {
      consecutiveRateLimits += 1;
      lastRateLimitAt = now.toISOString();
    }
  } else if (cooldownActive) state = "cooldown";
  else if (current.state === "quarantined" && !current.qualified) state = "quarantined";
  else if (hardFailure) {
    qualified = false;
    state = failureCode === "chatgpt_login_required" ? "login_required" : "quarantined";
  } else if (!authenticated) {
    qualified = false;
    state = "login_required";
  } else if (heartbeatStale || !extensionConnected || !pageReady || !sandboxVerified) {
    state = "stale";
  } else if (current.qualified) state = "ready";
  else state = "configured";

  if (rateLimited) {
    qualified = current.qualified;
  } else if (rateLimitState === "cooldown" && !cooldownActive) {
    rateLimitState = "clear";
    retryAfter = null;
  }

  return {
    state,
    qualified,
    extensionConnected,
    pageReady,
    authenticated,
    sandboxVerified,
    lastHeartbeatAt: heartbeat,
    rateLimitState,
    retryAfter,
    consecutiveRateLimits,
    lastRateLimitAt,
    lastSubmissionAt: healthString(health, "lastSubmissionAt") ?? current.lastSubmissionAt,
    lastFailureCode: failureCode ?? current.lastFailureCode,
    lastFailureAt: failureCode ? now.toISOString() : current.lastFailureAt,
    failurePhase: safeFailurePhase(health.failurePhase) ?? current.failurePhase,
    diagnosticSummary: safeDiagnosticSummary(health.diagnosticSummary) ?? current.diagnosticSummary,
    updatedAt: now.toISOString(),
  };
}

export class ChatGptWebPoolProvider implements ModelProvider {
  readonly name = "chatgpt_web" as const;
  readonly workspaceMode = "provider" as const;
  private readonly clients = new Map<string, RunnerClientProvider>();
  private readonly quotaClients = new Map<string, RunnerQuotaClient>();
  private readonly healthById = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly repository: JobRepository,
    private readonly configs: ChatGptWebAccountConfig[],
    bridgeApiToken: string,
    private readonly globalEnabled: boolean,
  ) {
    for (const config of configs) {
      this.clients.set(
        config.accountId,
        new RunnerClientProvider(config.bridgeUrl, bridgeApiToken, "chatgpt_web"),
      );
      this.quotaClients.set(
        config.accountId,
        new RunnerQuotaClient(config.bridgeUrl, bridgeApiToken),
      );
    }
  }

  async syncAccounts(): Promise<void> {
    await this.repository.syncChatGptWebAccounts(this.configs);
    await this.refreshHealth();
  }

  async refreshHealth(): Promise<void> {
    const accounts = await this.repository.listChatGptWebAccounts();
    await Promise.all(
      this.configs.map(async (config) => {
        const quotaClient = this.quotaClients.get(config.accountId);
        if (!quotaClient) return;
        try {
          const health = await quotaClient.readHealth();
          this.healthById.set(config.accountId, health);
          const current = accounts.find((account) => account.accountId === config.accountId);
          if (current) {
            await this.repository.updateChatGptWebAccount(
              config.accountId,
              accountPublicPatch(current, health, new Date()),
            );
          }
        } catch {
          this.healthById.delete(config.accountId);
          const current = accounts.find((account) => account.accountId === config.accountId);
          if (current) {
            await this.repository.updateChatGptWebAccount(
              config.accountId,
              accountPublicPatch(current, null, new Date()),
            );
          }
        }
      }),
    );
    await this.refreshAggregateStatus();
  }

  async refreshAggregateStatus(): Promise<ChatGptWebStatus> {
    const current = await this.repository.readChatGptWebStatus();
    const records = await this.repository.listChatGptWebAccounts();
    const accounts = records.map(safeAccount);
    const nowMs = Date.now();
    const qualified = accounts.filter((account) => account.enabled && account.qualified);
    const eligible = accounts.filter((account) => accountEligibleForLease(account, nowMs));
    const cooldownAccounts = qualified.filter((account) => accountCooldownActive(account, nowMs));
    const anyQualified = qualified.length > 0;
    const circuitState: ChatGptWebStatus["circuitState"] = !anyQualified
      ? "qualification_required"
      : eligible.length
        ? "closed"
        : "open";
    const rateLimitState: ChatGptWebStatus["rateLimitState"] =
      cooldownAccounts.length === qualified.length && qualified.length > 0
        ? "cooldown"
        : cooldownAccounts.length
          ? "observation"
          : "clear";
    const retryAfter = cooldownAccounts.length
      ? Math.min(...cooldownAccounts.map((account) => account.retryAfter ?? 1))
      : null;
    const lastFailure = records
      .filter((account) => account.lastFailureAt)
      .sort((left, right) =>
        String(right.lastFailureAt).localeCompare(String(left.lastFailureAt)),
      )[0];
    const lastSubmission = records
      .filter((account) => account.lastSubmissionAt)
      .sort((left, right) =>
        String(right.lastSubmissionAt).localeCompare(String(left.lastSubmissionAt)),
      )[0];
    const heartbeat = records
      .filter((account) => account.lastHeartbeatAt)
      .sort((left, right) =>
        String(right.lastHeartbeatAt).localeCompare(String(left.lastHeartbeatAt)),
      )[0];
    const configured = accounts.filter((account) => account.enabled);
    const healthValues = this.configs.map((config) => this.healthById.get(config.accountId));
    const activeTabs = healthValues.reduce(
      (total, health) => total + Number(health?.activeTabs ?? 0),
      0,
    );
    const slots = healthValues.flatMap((health) => healthSlots(health ?? {})).slice(0, 4);
    const next = ChatGptWebStatusSchema.parse({
      ...current,
      configuredEnabled: this.globalEnabled,
      effectiveConcurrency: this.globalEnabled ? eligible.length : 0,
      maximumConcurrency: Math.max(1, Math.min(4, this.configs.length)),
      activeTabs,
      sandboxVerified:
        configured.length > 0 && configured.every((account) => account.sandboxVerified),
      extensionConnected:
        configured.length > 0 && configured.every((account) => account.extensionConnected),
      pageReady: configured.length > 0 && configured.every((account) => account.pageReady),
      authenticated: configured.length > 0 && configured.every((account) => account.authenticated),
      circuitState,
      circuitReason:
        circuitState === "qualification_required"
          ? "qualification_not_completed"
          : circuitState === "open"
            ? "no_healthy_account"
            : null,
      cooldownUntil:
        rateLimitState === "cooldown" && retryAfter != null
          ? new Date(Date.now() + retryAfter * 1_000).toISOString()
          : null,
      rateLimitState,
      retryAfter,
      lastRateLimitAt:
        cooldownAccounts
          .map((account) => account.lastRateLimitAt)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? current.lastRateLimitAt,
      consecutiveRateLimits: Math.max(
        0,
        ...accounts.map((account) => account.consecutiveRateLimits),
      ),
      temporaryChatVerified: accounts.some((account) => account.lastProbePassed === true),
      lastQualifiedAt:
        accounts
          .map((account) => account.lastProbeAt)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? current.lastQualifiedAt,
      lastQualificationPassed: accounts.some((account) => account.lastProbePassed === true),
      activeJobId: accounts.find((account) => account.activeJobId)?.activeJobId ?? null,
      activeAttempt: null,
      lastHeartbeatAt: heartbeat?.lastHeartbeatAt ?? null,
      lastResetAt: current.lastResetAt,
      quarantinedTabs: healthValues.reduce(
        (total, health) => total + Number(health?.quarantinedTabs ?? 0),
        0,
      ),
      slots,
      accounts,
      phase: accounts.some((account) => account.state === "busy")
        ? "generating"
        : current.phase === "failed"
          ? "failed"
          : "idle",
      adapterVersion:
        healthValues.find((health) => typeof health?.adapterVersion === "string")?.adapterVersion ??
        current.adapterVersion,
      lastFailureCode: lastFailure?.lastFailureCode ?? current.lastFailureCode,
      lastSubmissionAt: lastSubmission?.lastSubmissionAt ?? current.lastSubmissionAt,
      updatedAt: new Date().toISOString(),
    });
    await this.repository.saveChatGptWebStatus(next);
    return next;
  }

  async capacity(): Promise<number> {
    const accounts = await this.repository.listChatGptWebAccounts();
    return accounts.filter((account) => accountEligibleForLease(account, Date.now())).length;
  }

  async admission(): Promise<void> {
    if (!this.globalEnabled) {
      throw new ChatGptWebPoolError(
        "chatgpt_web_circuit_open",
        "The ChatGPT web channel is disabled.",
        "not_submitted",
      );
    }
    const accounts = await this.repository.listChatGptWebAccounts();
    const qualified = accounts.filter((account) => account.enabled && account.qualified);
    if (!qualified.length) {
      throw new ChatGptWebPoolError(
        "chatgpt_web_circuit_open",
        "No ChatGPT web account has passed qualification.",
        "not_submitted",
      );
    }
    const now = Date.now();
    if (qualified.every((account) => accountCooldownActive(account, now))) {
      throw new ChatGptWebPoolError(
        "chatgpt_rate_limited",
        "All ChatGPT web accounts are cooling down.",
        "not_submitted",
      );
    }
  }

  private async waitForLease(
    jobId: string,
    excluded: Set<string>,
    signal?: AbortSignal,
  ): Promise<ChatGptWebAccountRecord> {
    while (!signal?.aborted) {
      const now = new Date();
      const ids = this.configs
        .map((config) => config.accountId)
        .filter((accountId) => !excluded.has(accountId));
      const leased = await this.repository.acquireChatGptWebAccountLease(
        jobId,
        ids,
        now,
        ACCOUNT_LEASE_MS,
      );
      if (leased) return leased;
      const accounts = await this.repository.listChatGptWebAccounts();
      const candidates = accounts.filter((account) => ids.includes(account.accountId));
      const qualified = candidates.filter((account) => account.enabled && account.qualified);
      if (!qualified.length) {
        throw new ChatGptWebPoolError(
          "chatgpt_web_circuit_open",
          "No healthy ChatGPT web account is available.",
          "not_submitted",
        );
      }
      if (qualified.every((account) => accountCooldownActive(account, now.getTime()))) {
        const retryAfter = Math.min(...qualified.map((account) => account.retryAfter ?? 1));
        throw new ChatGptWebPoolError(
          "chatgpt_rate_limited",
          `All ChatGPT web accounts are cooling down; retry after ${retryAfter} seconds.`,
          "not_submitted",
        );
      }
      await this.sleep(POOL_WAIT_MS, signal);
    }
    throw new ChatGptWebPoolError(
      "chatgpt_dispatch_cancelled",
      "ChatGPT web dispatch was cancelled before an account was submitted.",
      "not_submitted",
    );
  }

  private async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("chatgpt_dispatch_cancelled");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("chatgpt_dispatch_cancelled"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async release(
    account: ChatGptWebAccountRecord,
    jobId: string,
    patch: Partial<ChatGptWebAccount>,
  ): Promise<void> {
    await this.repository.releaseChatGptWebAccountLease(account.accountId, jobId, patch);
    await this.refreshAggregateStatus();
  }

  async invoke(invocation: ProviderInvocation): Promise<ProviderResult> {
    if (!invocation.jobId) throw new Error("runner_job_id_required");
    await this.admission();
    const excluded = new Set<string>();
    let lastPreSubmitError: ChatGptWebPoolError | null = null;

    while (!invocation.signal?.aborted && excluded.size < this.configs.length) {
      const account = await this.waitForLease(invocation.jobId, excluded, invocation.signal);
      excluded.add(account.accountId);
      const client = this.clients.get(account.accountId);
      if (!client) {
        await this.release(account, invocation.jobId, {
          state: "quarantined",
          qualified: false,
          lastFailureAt: new Date().toISOString(),
          lastFailureCode: "chatgpt_browser_unavailable",
        });
        lastPreSubmitError = new ChatGptWebPoolError(
          "chatgpt_browser_unavailable",
          "The configured account bridge is unavailable.",
          "not_submitted",
          account.accountId,
        );
        continue;
      }

      const phase = { value: null as ChatGptWebAccount["failurePhase"] };
      const onEvent = async (event: ProviderEvent) => {
        if (event.data.kind === "chatgpt_web") {
          phase.value = safeFailurePhase(event.data.phase);
        }
        await invocation.onEvent?.({
          ...event,
          data: { ...event.data, accountId: account.accountId },
        });
      };
      await invocation.onEvent?.({
        type: "tool",
        data: { kind: "chatgpt_web_account_assigned", accountId: account.accountId },
      });

      try {
        const result = await client.invoke({ ...invocation, onEvent });
        const now = new Date().toISOString();
        await this.release(account, invocation.jobId, {
          state: "ready",
          qualified: true,
          rateLimitState: "clear",
          retryAfter: null,
          consecutiveRateLimits: 0,
          lastSuccessAt: now,
          lastFailureAt: null,
          lastFailureCode: null,
          failurePhase: null,
          diagnosticSummary: null,
          lastSubmissionAt:
            phase.value && SUBMITTED_PHASES.has(phase.value) ? now : account.lastSubmissionAt,
        });
        return result;
      } catch (error) {
        const runnerError = error instanceof RunnerProviderError ? error : null;
        const code =
          runnerError?.code ??
          (error instanceof Error ? error.message.split(":", 1)[0]! : "provider_error");
        const submissionState = runnerError?.submissionState ?? "uncertain";
        const failurePhase = runnerError?.failurePhase ?? phase.value;
        const diagnosticSummary = runnerError?.diagnosticSummary ?? null;
        const now = new Date().toISOString();
        const hardFailure = HARD_FAILURE_CODES.has(code);
        const rateLimited = code === "chatgpt_rate_limited";
        // A pre-submit failure is safe to move to another qualified account. Once
        // the bridge accepted the invocation, the task stays pinned forever,
        // including for UI/login failures reported after the send boundary.
        const canFailover = submissionState === "not_submitted";
        await this.release(account, invocation.jobId, {
          state: rateLimited ? "cooldown" : hardFailure ? "quarantined" : "stale",
          qualified: hardFailure ? false : account.qualified,
          rateLimitState: rateLimited ? "cooldown" : account.rateLimitState,
          retryAfter: rateLimited ? (runnerError?.retryAfter ?? 1_800) : account.retryAfter,
          lastRateLimitAt: rateLimited ? now : account.lastRateLimitAt,
          lastFailureAt: now,
          lastFailureCode: code.slice(0, 128),
          failurePhase,
          diagnosticSummary,
          lastSubmissionAt: submissionState === "not_submitted" ? account.lastSubmissionAt : now,
        });
        const poolError = new ChatGptWebPoolError(
          code,
          runnerError?.message ?? (error instanceof Error ? error.message : String(error)),
          submissionState,
          account.accountId,
          failurePhase,
          diagnosticSummary,
        );
        if (canFailover) {
          lastPreSubmitError = poolError;
          continue;
        }
        throw poolError;
      }
    }

    if (lastPreSubmitError) throw lastPreSubmitError;
    throw new ChatGptWebPoolError(
      "chatgpt_dispatch_cancelled",
      "ChatGPT web dispatch ended before an account could submit.",
      "not_submitted",
    );
  }

  async listModels() {
    const clients = [...this.quotaClients.values()];
    for (const client of clients) {
      try {
        return await client.listModels();
      } catch {
        continue;
      }
    }
    throw new Error("runner_models_unavailable:pool");
  }

  async readHealth(): Promise<Record<string, unknown>> {
    const status = await this.refreshAggregateStatus();
    return {
      status: status.circuitState === "closed" ? "ready" : "unavailable",
      service: "aialra-chatgpt-web-pool",
      enabled: this.globalEnabled,
      accounts: status.accounts,
      activeTabs: status.activeTabs,
      extensionConnected: status.extensionConnected,
      pageReady: status.pageReady,
      authenticated: status.authenticated,
      sandboxVerified: status.sandboxVerified,
      effectiveConcurrency: status.effectiveConcurrency,
      maximumConcurrency: status.maximumConcurrency,
      pending: status.queuedJobs,
    };
  }
}
