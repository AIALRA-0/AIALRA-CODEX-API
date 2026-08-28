import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import Ajv from "ajv";

import type {
  Job,
  QuotaSnapshot,
  RouteDecision,
  UsageLedger,
  ValidationResult,
} from "@aialra/contracts";
import type { JobRepository } from "@aialra/persistence";
import {
  type ModelProvider,
  CodexQuotaClient,
  isTransientProviderError,
  unavailableQuotaSnapshot,
} from "@aialra/providers";
import { selectRoute } from "@aialra/router";
import { redact, scanForExternalData } from "@aialra/security";

const TERMINAL_STATUSES = new Set(["succeeded", "needs_review", "failed", "cancelled", "expired"]);

export interface WorkerDependencies {
  repository: JobRepository;
  provider: ModelProvider;
  quotaClient?: Pick<CodexQuotaClient, "read">;
  createWorkspace?: () => Promise<string>;
  removeWorkspace?: (path: string) => Promise<void>;
}

function validateAcceptanceTests(output: unknown, tests: string[]): string[] {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const failures: string[] = [];
  for (const test of tests) {
    if (test.startsWith("contains:")) {
      const expected = test.slice("contains:".length);
      if (!text.includes(expected)) {
        failures.push(`acceptance_test_failed:${test}`);
      }
    } else {
      failures.push(`acceptance_test_requires_review:${test}`);
    }
  }
  return failures;
}

export function validateOutput(job: Job, output: unknown): ValidationResult {
  const messages: string[] = [];
  let schemaPassed: boolean | null = null;
  if (job.task.validation.responseSchema) {
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
  }

  const acceptanceFailures = validateAcceptanceTests(output, job.task.validation.acceptanceTests);
  messages.push(...acceptanceFailures);
  return {
    passed: schemaPassed !== false && acceptanceFailures.length === 0,
    schemaPassed,
    testsPassed: job.task.validation.acceptanceTests.length - acceptanceFailures.length,
    testsFailed: acceptanceFailures.length,
    messages,
  };
}

export function attachQuotaWindowDelta(
  usage: UsageLedger,
  before: QuotaSnapshot,
  after: QuotaSnapshot,
): UsageLedger {
  const sameWindow =
    before.source === "app-server" &&
    after.source === "app-server" &&
    before.resetsAt != null &&
    before.resetsAt === after.resetsAt &&
    before.windowDurationMinutes != null &&
    before.windowDurationMinutes === after.windowDurationMinutes;
  const hasPercentages = before.usedPercent != null && after.usedPercent != null;
  const delta =
    sameWindow && hasPercentages && after.usedPercent! >= before.usedPercent!
      ? after.usedPercent! - before.usedPercent!
      : null;

  return {
    ...usage,
    quotaUsedPercentBefore: before.usedPercent,
    quotaUsedPercentAfter: after.usedPercent,
    quotaWindowDeltaPercent: delta,
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
  private readonly provider: ModelProvider;
  private readonly quotaClient: Pick<CodexQuotaClient, "read">;
  private readonly createWorkspace: () => Promise<string>;
  private readonly removeWorkspace: (path: string) => Promise<void>;

  constructor(dependencies: WorkerDependencies) {
    this.repository = dependencies.repository;
    this.provider = dependencies.provider;
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

  async processJob(jobId: string, queueSignal?: AbortSignal): Promise<void> {
    let job = await this.repository.findById(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) {
      return;
    }

    const elevated =
      (job.task.permissions.filesystem === "write" &&
        job.task.permissions.requireApprovalForWrites) ||
      (job.task.permissions.network === "allowlist" &&
        job.task.permissions.requireApprovalForExternalActions);
    if (elevated) {
      const events = await this.repository.events(jobId);
      const approved = events.some(
        (event) => event.type === "approval" && event.data.status === "approved",
      );
      if (!approved) {
        await this.transition(
          jobId,
          {
            status: "needs_review",
            errorCode: "approval_required",
            errorMessage: "Elevated permissions require an approval event before execution.",
          },
          "worker.approval_required",
        );
        return;
      }
    }

    const quota = await this.readQuota();
    let route: RouteDecision;
    try {
      route = selectRoute(job.task, quota);
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : "routing_rejected";
      await this.transition(
        jobId,
        {
          status: "needs_review",
          errorCode,
          errorMessage: "The current Codex quota policy rejected this automatic route.",
        },
        "worker.routing_rejected",
      );
      await this.repository.appendEvent(jobId, "error", { code: errorCode });
      return;
    }
    job = await this.repository.update(jobId, { route });
    await this.transition(jobId, { status: "running" }, "worker.running");

    const workspace =
      this.provider.workspaceMode === "provider" ? null : await this.createWorkspace();
    const deadlineSignal = AbortSignal.timeout(job.task.deadlineMs);
    const signal = queueSignal ? AbortSignal.any([queueSignal, deadlineSignal]) : deadlineSignal;
    let lastError: unknown = null;

    try {
      for (let attempt = 1; attempt <= job.task.budget.maxAttempts; attempt += 1) {
        try {
          const result = await this.provider.invoke({
            jobId,
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
          const quotaAfter = await this.readQuota();
          const usage = attachQuotaWindowDelta(result.usage, quota, quotaAfter);
          await this.repository.appendEvent(jobId, "usage", usage);
          await this.transition(jobId, { status: "validating" }, "worker.validating");
          const validation = validateOutput(current, result.output);
          await this.repository.appendEvent(jobId, "validation", validation);
          const terminalStatus = validation.passed ? "succeeded" : "needs_review";
          await this.transition(
            jobId,
            {
              status: terminalStatus,
              output: result.output,
              usage,
              validation,
              task: result.threadId
                ? { ...current.task, sessionKey: result.threadId }
                : current.task,
            },
            `worker.${terminalStatus}`,
          );
          return;
        } catch (error) {
          lastError = error;
          const canRetry = attempt < job.task.budget.maxAttempts && isTransientProviderError(error);
          if (!canRetry) {
            break;
          }
          await this.repository.appendEvent(jobId, "error", {
            code: "transient_provider_error",
            attempt,
            retrying: true,
          });
        }
      }

      const message = redact(lastError instanceof Error ? lastError.message : String(lastError));
      const status = signal.aborted ? "expired" : "failed";
      await this.transition(
        jobId,
        {
          status,
          errorCode: signal.aborted ? "deadline_exceeded" : "provider_error",
          errorMessage: message.slice(0, 1_000),
        },
        `worker.${status}`,
      );
      await this.repository.appendEvent(jobId, "error", {
        code: signal.aborted ? "deadline_exceeded" : "provider_error",
        message: message.slice(0, 1_000),
      });
    } finally {
      if (workspace) await this.removeWorkspace(workspace);
    }
  }
}
