import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import Ajv from "ajv";

import type {
  ChatGptWebStatus,
  Job,
  QuotaSnapshot,
  RouteDecision,
  UsageLedger,
  ValidationResult,
} from "@aialra/contracts";
import { parseLegacyValidationCheck, sessionThreadTtlMs } from "@aialra/contracts";
import type { JobRepository } from "@aialra/persistence";
import {
  type ModelProvider,
  CodexQuotaClient,
  isTransientProviderError,
  unavailableQuotaSnapshot,
} from "@aialra/providers";
import { selectRoute } from "@aialra/router";
import { redact, scanForExternalData } from "@aialra/security";

import type { ChatGptWebPoolProvider } from "./chatgpt-web-pool.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"]);
const CHATGPT_WEB_MIN_DISPATCH_INTERVAL_MS = 90_000;
const CHATGPT_WEB_COOLDOWN_MINUTES = [30, 60, 120] as const;

export interface WorkerDependencies {
  repository: JobRepository;
  provider: ModelProvider;
  chatgptProvider?: ModelProvider;
  chatgptPool?: ChatGptWebPoolProvider;
  quotaClient?: Pick<CodexQuotaClient, "read">;
  createWorkspace?: () => Promise<string>;
  removeWorkspace?: (path: string) => Promise<void>;
}

function outputText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function summarize(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

function providerErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(":", 1)[0] || "provider_error";
}

export function isSafeChatGptWebRetry(error: unknown): boolean {
  void error;
  return false;
}

function validateChecks(output: unknown, checks: Job["task"]["validation"]["checks"]): string[] {
  const text = outputText(output);
  const failures: string[] = [];
  for (const check of checks) {
    if (check.type === "equals") {
      const actual = check.trim ? text.trim() : text;
      const expected = check.trim ? check.expected.trim() : check.expected;
      if (actual !== expected) {
        failures.push(
          `equals_failed:expected=${JSON.stringify(expected)}:actual=${JSON.stringify(summarize(actual))}`,
        );
      }
    } else if (!text.includes(check.expected)) {
      failures.push(`contains_failed:expected=${JSON.stringify(check.expected)}`);
    }
  }
  return failures;
}

function validateAcceptanceTests(output: unknown, tests: string[]): string[] {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const failures: string[] = [];
  for (const test of tests) {
    const check = parseLegacyValidationCheck(test, true);
    if (!check) {
      failures.push(`invalid_validation_rule:${test}`);
      continue;
    }
    if (check.type === "equals") {
      const actual = check.trim ? text.trim() : text;
      const expected = check.trim ? check.expected.trim() : check.expected;
      if (actual !== expected) failures.push(`acceptance_test_failed:${test}`);
    } else if (!text.includes(check.expected)) {
      failures.push(`acceptance_test_failed:${test}`);
    }
  }
  return failures;
}

export function validateOutput(job: Job, output: unknown): ValidationResult {
  const messages: string[] = [];
  let schemaPassed: boolean | null = null;
  if (job.task.validation.responseSchema) {
    try {
      const ajv = new Ajv({ allErrors: true, strict: false });
      const validate = ajv.compile(job.task.validation.responseSchema);
      schemaPassed = validate(output);
      if (!schemaPassed) {
        messages.push(
          ...(validate.errors ?? []).map(
            (error) => `schema:${error.instancePath || "/"}:${error.message ?? "invalid"}`,
          ),
        );
      }
    } catch (error) {
      schemaPassed = false;
      messages.push(
        `invalid_response_schema:${error instanceof Error ? error.message : "compile_failed"}`,
      );
    }
  }

  const checkFailures = validateChecks(output, job.task.validation.checks);
  const acceptanceFailures = validateAcceptanceTests(output, job.task.validation.acceptanceTests);
  messages.push(...checkFailures, ...acceptanceFailures);
  const totalChecks =
    job.task.validation.checks.length + job.task.validation.acceptanceTests.length;
  const failedChecks = checkFailures.length + acceptanceFailures.length;
  return {
    passed: schemaPassed !== false && failedChecks === 0,
    schemaPassed,
    testsPassed: totalChecks - failedChecks,
    testsFailed: failedChecks,
    messages,
  };
}

export function attachQuotaWindowDelta(
  usage: UsageLedger,
  before: QuotaSnapshot,
  after: QuotaSnapshot,
): UsageLedger {
  const beforePrimary = before.windows?.find((window) => window.id === "codex:primary");
  const afterPrimary = after.windows?.find((window) => window.id === "codex:primary");
  const beforeUsed = beforePrimary?.usedPercent ?? before.usedPercent;
  const afterUsed = afterPrimary?.usedPercent ?? after.usedPercent;
  const beforeReset = beforePrimary?.resetsAt ?? before.resetsAt;
  const afterReset = afterPrimary?.resetsAt ?? after.resetsAt;
  const beforeDuration = beforePrimary?.windowDurationMinutes ?? before.windowDurationMinutes;
  const afterDuration = afterPrimary?.windowDurationMinutes ?? after.windowDurationMinutes;
  const sameWindow =
    before.source === "app-server" &&
    after.source === "app-server" &&
    beforeReset != null &&
    beforeReset === afterReset &&
    beforeDuration != null &&
    beforeDuration === afterDuration;
  const hasPercentages = beforeUsed != null && afterUsed != null;
  const delta =
    sameWindow && hasPercentages && afterUsed! >= beforeUsed! ? afterUsed! - beforeUsed! : null;

  return {
    ...usage,
    quotaUsedPercentBefore: beforeUsed,
    quotaUsedPercentAfter: afterUsed,
    quotaWindowDeltaPercent: delta,
  };
}

export function nextChatGptWebStatus(
  current: ChatGptWebStatus,
  outcome: { succeeded: boolean; errorCode?: string | null },
  now = new Date(),
): ChatGptWebStatus {
  const next: ChatGptWebStatus = {
    ...current,
    attemptsAtCurrentLevel: current.attemptsAtCurrentLevel + 1,
    successesAtCurrentLevel: current.successesAtCurrentLevel + (outcome.succeeded ? 1 : 0),
    updatedAt: now.toISOString(),
  };
  if (outcome.succeeded) {
    const recoverySucceeded = current.rateLimitState === "recovery_probe";
    const observationSucceeded = current.rateLimitState === "observation";
    const observationComplete =
      (recoverySucceeded || observationSucceeded) && next.successesAtCurrentLevel >= 3;
    return {
      ...next,
      effectiveConcurrency: 1,
      maximumConcurrency: 1,
      severeErrorsAtCurrentLevel: 0,
      circuitState: "closed",
      circuitReason: null,
      cooldownUntil: null,
      rateLimitState: observationComplete
        ? "clear"
        : recoverySucceeded || observationSucceeded
          ? "observation"
          : current.rateLimitState,
      retryAfter: null,
      consecutiveRateLimits: observationComplete ? 0 : current.consecutiveRateLimits,
      lastRecoveryProbePassed: recoverySucceeded ? true : current.lastRecoveryProbePassed,
    };
  }

  const code = outcome.errorCode ?? "chatgpt_web_failed";
  if (code === "chatgpt_rate_limited") {
    const consecutiveRateLimits = current.consecutiveRateLimits + 1;
    const cooldownMinutes =
      CHATGPT_WEB_COOLDOWN_MINUTES[
        Math.min(consecutiveRateLimits - 1, CHATGPT_WEB_COOLDOWN_MINUTES.length - 1)
      ]!;
    const cooldownUntil = new Date(now.getTime() + cooldownMinutes * 60_000);
    return {
      ...next,
      effectiveConcurrency: 0,
      maximumConcurrency: 1,
      severeErrorsAtCurrentLevel: current.severeErrorsAtCurrentLevel + 1,
      circuitState: "cooldown",
      circuitReason: code,
      cooldownUntil: cooldownUntil.toISOString(),
      rateLimitState: "cooldown",
      retryAfter: cooldownMinutes * 60,
      lastRateLimitAt: now.toISOString(),
      consecutiveRateLimits,
      successesAtCurrentLevel: 0,
      lastRecoveryProbePassed: false,
    };
  }
  const qualificationRequired = new Set([
    "duplicate_browser_job",
    "chatgpt_delivery_uncertain",
    "chatgpt_output_selector_changed",
  ]).has(code);
  const hardStop =
    qualificationRequired ||
    new Set(["chatgpt_login_required", "chatgpt_verification_required", "chatgpt_ui_changed"]).has(
      code,
    );
  if (hardStop) {
    return {
      ...next,
      effectiveConcurrency: 0,
      severeErrorsAtCurrentLevel: current.severeErrorsAtCurrentLevel + 1,
      circuitState: qualificationRequired ? "qualification_required" : "open",
      circuitReason: code,
      cooldownUntil: null,
      lastQualificationPassed: qualificationRequired ? false : current.lastQualificationPassed,
    };
  }
  const consecutiveFailures = current.severeErrorsAtCurrentLevel + 1;
  if (consecutiveFailures >= 3) {
    return {
      ...next,
      effectiveConcurrency: 0,
      maximumConcurrency: 1,
      severeErrorsAtCurrentLevel: consecutiveFailures,
      circuitState: "qualification_required",
      circuitReason: "consecutive_failures",
      cooldownUntil: null,
      lastQualificationPassed: false,
    };
  }
  return {
    ...next,
    effectiveConcurrency: 1,
    maximumConcurrency: 1,
    severeErrorsAtCurrentLevel: consecutiveFailures,
  };
}

async function defaultCreateWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "aialra-router-"));
}

async function defaultRemoveWorkspace(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export class WorkerService {
  private readonly repository: JobRepository;
  private readonly providers: Map<RouteDecision["provider"], ModelProvider>;
  private readonly quotaClient: Pick<CodexQuotaClient, "read">;
  private readonly createWorkspace: () => Promise<string>;
  private readonly removeWorkspace: (path: string) => Promise<void>;
  private readonly chatgptWebPool?: ChatGptWebPoolProvider;
  private chatGptWebStatusTail: Promise<void> = Promise.resolve();
  private chatGptWebDispatchTail: Promise<void> = Promise.resolve();

  constructor(dependencies: WorkerDependencies) {
    this.repository = dependencies.repository;
    this.providers = new Map([[dependencies.provider.name, dependencies.provider]]);
    if (dependencies.chatgptProvider) {
      this.providers.set(dependencies.chatgptProvider.name, dependencies.chatgptProvider);
    }
    this.chatgptWebPool = dependencies.chatgptPool;
    this.quotaClient = dependencies.quotaClient ?? new CodexQuotaClient();
    this.createWorkspace = dependencies.createWorkspace ?? defaultCreateWorkspace;
    this.removeWorkspace = dependencies.removeWorkspace ?? defaultRemoveWorkspace;
  }

  private async readQuota(): Promise<QuotaSnapshot> {
    try {
      const snapshot = await this.quotaClient.read();
      await this.repository.saveQuotaSnapshot(snapshot);
      return snapshot;
    } catch {
      const snapshot = unavailableQuotaSnapshot();
      await this.repository.saveQuotaSnapshot(snapshot);
      return snapshot;
    }
  }

  private async transition(
    jobId: string,
    patch: Partial<Job> & { status: Job["status"] },
    action: string,
  ): Promise<Job> {
    return this.repository.transitionJob(jobId, patch, {
      id: randomUUID(),
      actorId: "worker",
      action,
      resourceType: "job",
      resourceId: jobId,
      metadata: { status: patch.status },
      createdAt: new Date().toISOString(),
    });
  }

  private async recordChatGptWebOutcome(
    succeeded: boolean,
    errorCode: string | null = null,
  ): Promise<void> {
    await this.mutateChatGptWebStatus((current) =>
      nextChatGptWebStatus(current, { succeeded, errorCode }),
    );
  }

  private chatGptWebDispatchError(
    status: ChatGptWebStatus,
    nowMs: number,
  ): "chatgpt_rate_limited" | "chatgpt_web_circuit_open" | null {
    if (status.rateLimitState === "recovery_probe") {
      return "chatgpt_rate_limited";
    }
    if (status.rateLimitState === "cooldown") {
      const cooldownUntil = status.cooldownUntil
        ? new Date(status.cooldownUntil).getTime()
        : Number.POSITIVE_INFINITY;
      if (cooldownUntil > nowMs) {
        return "chatgpt_rate_limited";
      }
    }
    if (
      !status.configuredEnabled ||
      ["open", "qualification_required"].includes(status.circuitState)
    ) {
      return "chatgpt_web_circuit_open";
    }
    return null;
  }

  private async waitForChatGptWebDispatch(waitMs: number, signal?: AbortSignal): Promise<void> {
    if (waitMs <= 0) return;
    if (signal?.aborted) throw new Error("chatgpt_dispatch_cancelled");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("chatgpt_dispatch_cancelled"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, waitMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async performChatGptWebDispatchReservation(signal?: AbortSignal): Promise<void> {
    const observed = await this.repository.readChatGptWebStatus();
    const dispatchError = this.chatGptWebDispatchError(observed, Date.now());
    if (dispatchError) throw new Error(dispatchError);

    const lastSubmissionAt = observed.lastSubmissionAt
      ? new Date(observed.lastSubmissionAt).getTime()
      : 0;
    const waitMs = Math.max(
      0,
      CHATGPT_WEB_MIN_DISPATCH_INTERVAL_MS - (Date.now() - lastSubmissionAt),
    );
    await this.waitForChatGptWebDispatch(waitMs, signal);

    const reservedAt = new Date();
    await this.mutateChatGptWebStatus((current) => {
      const currentDispatchError = this.chatGptWebDispatchError(current, reservedAt.getTime());
      if (currentDispatchError) throw new Error(currentDispatchError);
      const startsRecoveryProbe = current.rateLimitState === "cooldown";
      return {
        ...current,
        ...(startsRecoveryProbe
          ? {
              effectiveConcurrency: 1,
              circuitState: "closed" as const,
              circuitReason: null,
              cooldownUntil: null,
              rateLimitState: "recovery_probe" as const,
              retryAfter: null,
              lastRecoveryProbeAt: reservedAt.toISOString(),
              lastRecoveryProbePassed: null,
              successesAtCurrentLevel: 0,
            }
          : {}),
        lastSubmissionAt: reservedAt.toISOString(),
        temporaryChatVerified: false,
        updatedAt: reservedAt.toISOString(),
      };
    });
  }

  private reserveChatGptWebDispatch(signal?: AbortSignal): Promise<void> {
    const operation = this.chatGptWebDispatchTail.then(() =>
      this.performChatGptWebDispatchReservation(signal),
    );
    this.chatGptWebDispatchTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async mutateChatGptWebStatus(
    update: (current: ChatGptWebStatus) => ChatGptWebStatus,
  ): Promise<ChatGptWebStatus> {
    const operation = this.chatGptWebStatusTail.then(async () => {
      const current = await this.repository.readChatGptWebStatus();
      const next = update(current);
      await this.repository.saveChatGptWebStatus(next);
      return next;
    });
    this.chatGptWebStatusTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async processJob(jobId: string, queueSignal?: AbortSignal): Promise<void> {
    let job = await this.repository.findById(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) {
      return;
    }
    if (job.status === "awaiting_approval") {
      return;
    }

    if (job.task.permissions.preset === "confirm") {
      const events = await this.repository.events(jobId);
      const approved = events.some(
        (event) => event.type === "approval" && event.data.status === "approved",
      );
      if (!approved) {
        await this.transition(
          jobId,
          {
            status: "failed",
            errorCode: "approval_missing",
            errorMessage: "A confirm-mode job reached the Worker without approval.",
          },
          "worker.approval_missing",
        );
        return;
      }
    }

    if (job.task.executionChannel === "chatgpt_web") {
      let admissionError: unknown = null;
      if (this.chatgptWebPool) {
        try {
          await this.chatgptWebPool.admission();
        } catch (error) {
          admissionError = error;
        }
      } else {
        const status = await this.repository.readChatGptWebStatus();
        const cooldownActive =
          status.rateLimitState === "cooldown" &&
          (!status.cooldownUntil || new Date(status.cooldownUntil).getTime() > Date.now());
        if (
          !status.configuredEnabled ||
          cooldownActive ||
          ["open", "qualification_required"].includes(status.circuitState)
        ) {
          admissionError = new Error(
            cooldownActive ? "chatgpt_rate_limited" : "chatgpt_web_circuit_open",
          );
        }
      }
      if (admissionError) {
        const errorCode = providerErrorCode(admissionError);
        await this.transition(
          jobId,
          {
            status: "failed",
            errorCode,
            errorMessage:
              errorCode === "chatgpt_rate_limited"
                ? "ChatGPT web usage is cooling down after a rate limit."
                : "The ChatGPT web experiment is disabled or has not passed its gate.",
          },
          "worker.chatgpt_web_circuit_open",
        );
        return;
      }
    }

    if (job.task.executionChannel === "chatgpt_web" && !this.chatgptWebPool) {
      try {
        await this.reserveChatGptWebDispatch(queueSignal);
      } catch (error) {
        const errorCode = providerErrorCode(error);
        if (!new Set(["chatgpt_rate_limited", "chatgpt_web_circuit_open"]).has(errorCode)) {
          throw error;
        }
        await this.transition(
          jobId,
          {
            status: "failed",
            errorCode,
            errorMessage:
              errorCode === "chatgpt_rate_limited"
                ? "ChatGPT web usage is cooling down or a recovery probe is still running."
                : "The ChatGPT web experiment is disabled or has not passed its gate.",
          },
          "worker.chatgpt_web_dispatch_rejected",
        );
        await this.repository.appendEvent(jobId, "error", { code: errorCode });
        return;
      }
    }

    const quota =
      job.task.executionChannel === "chatgpt_web"
        ? unavailableQuotaSnapshot()
        : await this.readQuota();
    let route: RouteDecision;
    try {
      route = job.route ?? selectRoute(job.task, quota);
      const settings = await this.repository.listModelSettings();
      const setting = settings.find((candidate) => candidate.modelId === route.model);
      if (setting?.enabled === false || (!setting && !route.model.startsWith("gpt-5.6-"))) {
        throw new Error("model_disabled");
      }
      const catalog = await this.repository.latestModelCatalog();
      if (
        catalog &&
        !catalog.models.some(
          (model) =>
            model.id === route.model &&
            model.available &&
            (model.provider ?? "codex") === route.provider,
        )
      ) {
        throw new Error("model_unavailable");
      }
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : "routing_rejected";
      await this.transition(
        jobId,
        {
          status: "failed",
          errorCode,
          errorMessage: "The current routing policy rejected this execution channel or model.",
        },
        "worker.routing_rejected",
      );
      await this.repository.appendEvent(jobId, "error", { code: errorCode });
      return;
    }
    job = await this.repository.update(jobId, { route });
    const provider = this.providers.get(route.provider);
    if (!provider) {
      await this.transition(
        jobId,
        {
          status: "failed",
          errorCode: `${route.provider}_adapter_unavailable`,
          errorMessage: "The selected execution channel is not enabled on this Worker.",
        },
        "worker.provider_unavailable",
      );
      return;
    }

    if (route.provider === "codex" && job.task.sessionKey) {
      const thread = await this.repository.findSessionThread(job.task.sessionKey);
      if (!thread || new Date(thread.expiresAt).getTime() <= Date.now()) {
        await this.transition(
          jobId,
          {
            status: "failed",
            errorCode: "session_expired",
            errorMessage: "The Codex conversation thread no longer exists or has expired.",
          },
          "worker.session_expired",
        );
        await this.repository.appendEvent(jobId, "error", { code: "session_expired" });
        return;
      }
    }

    await this.transition(jobId, { status: "running" }, "worker.running");

    const workspace = provider.workspaceMode === "provider" ? null : await this.createWorkspace();
    const deadlineSignal = AbortSignal.timeout(job.task.deadlineMs);
    const signal = queueSignal ? AbortSignal.any([queueSignal, deadlineSignal]) : deadlineSignal;
    let lastError: unknown = null;

    try {
      const allowedAttempts = route.provider === "chatgpt_web" ? 1 : job.task.budget.maxAttempts;
      for (let attempt = 1; attempt <= allowedAttempts; attempt += 1) {
        try {
          const result = await provider.invoke({
            jobId,
            attempt,
            task: job.task,
            route,
            workingDirectory: workspace ?? undefined,
            signal,
            onEvent: async (event) => {
              const scan = scanForExternalData(event.data);
              if (!scan.allowed) {
                throw new Error(`secret_output_blocked:${scan.findings.join(",")}`);
              }
              await this.repository.appendEvent(jobId, event.type, event.data);
            },
          });

          const outputScan = scanForExternalData(result.output);
          if (!outputScan.allowed) {
            await this.repository.appendEvent(jobId, "error", {
              code: "secret_output_blocked",
              findings: outputScan.findings,
            });
            throw new Error("secret_output_blocked");
          }

          const current = await this.repository.findById(jobId);
          if (!current || current.status === "cancelled") {
            return;
          }
          const measuredUsage =
            route.provider === "codex"
              ? attachQuotaWindowDelta(result.usage, quota, await this.readQuota())
              : result.usage;
          const usage = {
            ...measuredUsage,
            attemptCount: attempt,
            retryCount: Math.max(0, attempt - 1),
          };
          if (result.sources?.length) {
            await this.repository.appendEvent(jobId, "tool", {
              kind: "chatgpt_web_sources",
              sources: result.sources,
            });
          }
          await this.repository.appendEvent(jobId, "usage", usage);
          if (route.provider === "codex" && result.threadId) {
            const existingThread = await this.repository.findSessionThread(result.threadId);
            const threadNow = new Date();
            await this.repository.upsertSessionThread({
              sessionKey: result.threadId,
              callerId: current.callerId,
              model: route.model,
              effort: route.effort,
              turnCount: (existingThread?.turnCount ?? 0) + 1,
              createdAt: existingThread?.createdAt ?? threadNow.toISOString(),
              lastUsedAt: threadNow.toISOString(),
              expiresAt: new Date(threadNow.getTime() + sessionThreadTtlMs()).toISOString(),
            });
          }
          await this.transition(jobId, { status: "validating" }, "worker.validating");
          const validation = validateOutput(current, result.output);
          await this.repository.appendEvent(jobId, "validation", validation);
          const terminalStatus = validation.passed ? "succeeded" : "failed";
          await this.transition(
            jobId,
            {
              status: terminalStatus,
              output: result.output,
              usage,
              validation,
              errorCode: validation.passed ? null : "validation_failed",
              errorMessage: validation.passed
                ? null
                : "The model output did not satisfy the declared validation rules.",
              task: result.threadId
                ? { ...current.task, sessionKey: result.threadId }
                : current.task,
            },
            `worker.${terminalStatus}`,
          );
          if (route.provider === "chatgpt_web" && !this.chatgptWebPool) {
            await this.recordChatGptWebOutcome(
              validation.passed,
              validation.passed ? null : "validation_failed",
            );
          }
          return;
        } catch (error) {
          lastError = error;
          const canRetry =
            attempt < allowedAttempts &&
            (route.provider === "codex"
              ? isTransientProviderError(error)
              : isSafeChatGptWebRetry(error));
          if (!canRetry) {
            break;
          }
          await this.repository.appendEvent(jobId, "error", {
            code:
              route.provider === "chatgpt_web"
                ? providerErrorCode(error)
                : "transient_provider_error",
            attempt,
            nextAttempt: attempt + 1,
            retrying: true,
          });
        }
      }

      const message = redact(lastError instanceof Error ? lastError.message : String(lastError));
      const status = signal.aborted ? "expired" : "failed";
      const finalErrorCode = signal.aborted ? "deadline_exceeded" : providerErrorCode(lastError);
      await this.transition(
        jobId,
        {
          status,
          errorCode: finalErrorCode,
          errorMessage: message.slice(0, 1_000),
        },
        `worker.${status}`,
      );
      await this.repository.appendEvent(jobId, "error", {
        code: finalErrorCode,
        message: message.slice(0, 1_000),
      });
      if (route.provider === "chatgpt_web" && !this.chatgptWebPool) {
        const providerCode = message.split(":", 1)[0] || "provider_error";
        await this.recordChatGptWebOutcome(
          false,
          signal.aborted ? "chatgpt_timeout" : providerCode,
        );
      }
    } finally {
      if (workspace) await this.removeWorkspace(workspace);
    }
  }
}
