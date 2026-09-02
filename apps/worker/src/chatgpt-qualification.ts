import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import {
  ChatGptWebDiagnosticSummarySchema,
  ChatGptWebFailurePhaseSchema,
  TaskContractSchema,
  type ChatGptWebDiagnosticSummary,
  type ChatGptWebFailurePhase,
  type ChatGptWebMode,
  type ChatGptWebQualificationItem,
  type ChatGptWebQualificationRun,
} from "@aialra/contracts";
import type { JobRepository } from "@aialra/persistence";

type QualificationDefinition = {
  name: string;
  mode: ChatGptWebMode;
  marker: string;
  objective: string;
  requireSources: boolean;
  deadlineMs: number;
};

type DiagnosticResult = {
  outputText: string;
  sources: string[];
  submittedCount: number;
  recoveryCount: number;
  temporaryChatVerified: boolean;
};

export class DiagnosticInvocationError extends Error {
  constructor(
    message: string,
    readonly submittedCount: number,
    readonly recoveryCount: number,
    readonly temporaryChatVerified = false,
    readonly failurePhase: ChatGptWebFailurePhase | null = null,
    readonly diagnosticSummary: ChatGptWebDiagnosticSummary | null = null,
  ) {
    super(message);
  }
}

function allDefinitions(runId: string): QualificationDefinition[] {
  const suffix = (name: string) =>
    createHash("sha256").update(`${runId}:${name}`).digest("hex").slice(0, 8).toUpperCase();
  return [
    ...Array.from({ length: 4 }, (_, index) => {
      const name = `chat-${index + 1}`;
      const marker = `AIALRA_CHAT_${index + 1}_${suffix(name)}`;
      return {
        name: `chat-${index + 1}`,
        mode: "chat" as const,
        marker,
        objective: `用一句简短中文回答，并在结尾原样写出 ${marker}`,
        requireSources: false,
        deadlineMs: 600_000,
      };
    }),
    ...Array.from({ length: 4 }, (_, index) => {
      const name = `search-${index + 1}`;
      const marker = `AIALRA_SEARCH_${index + 1}_${suffix(name)}`;
      return {
        name: `search-${index + 1}`,
        mode: "search" as const,
        marker,
        objective: `联网查找今天可访问的一项公开技术资料，用两句话概括，列出来源，并在结尾原样写出 ${marker}`,
        requireSources: true,
        deadlineMs: 600_000,
      };
    }),
    ...Array.from({ length: 2 }, (_, index) => {
      const name = `deep-${index + 1}`;
      const marker = `AIALRA_DEEP_${index + 1}_${suffix(name)}`;
      return {
        name: `deep-${index + 1}`,
        mode: "deep_research" as const,
        marker,
        objective: `执行一次深度研究，比较两种公开的软件测试方法，给出来源，并在结尾原样写出 ${marker}。不要向我提问，直接完成研究`,
        requireSources: true,
        deadlineMs: 3_600_000,
      };
    }),
  ];
}

function definitionsFor(run: ChatGptWebQualificationRun): QualificationDefinition[] {
  const definitions = allDefinitions(run.id);
  if (run.suite === "single_probe")
    return definitions.filter((item) => item.mode === "chat").slice(0, 1);
  if (run.suite === "chat_3") return definitions.filter((item) => item.mode === "chat").slice(0, 3);
  if (run.suite === "chat_10") {
    return Array.from({ length: 10 }, (_, index) => {
      const base = definitions[index % 4]!;
      const name = `chat-${index + 1}`;
      const marker = `AIALRA_CHAT_${index + 1}_${createHash("sha256")
        .update(`${run.id}:${name}`)
        .digest("hex")
        .slice(0, 8)
        .toUpperCase()}`;
      return {
        ...base,
        name,
        marker,
        objective: `用一句简短中文回答，并在结尾原样写出 ${marker}`,
      };
    });
  }
  if (run.suite === "deep_2") return definitions.filter((item) => item.mode === "deep_research");
  if (run.suite === "full_10") return definitions;
  return [];
}

export class ChatGptWebDiagnosticClient {
  private lastInvocationAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly diagnosticToken: string,
  ) {}

  async health(): Promise<Record<string, unknown>> {
    const response = await fetch(new URL("/healthz", this.baseUrl), {
      headers: { authorization: `Bearer ${this.apiToken}` },
    });
    if (![200, 503].includes(response.status)) throw new Error("chatgpt_browser_unavailable");
    return (await response.json()) as Record<string, unknown>;
  }

  private async waitForIdleSlot(deadlineMs: number): Promise<void> {
    const deadline = Date.now() + Math.min(deadlineMs, 660_000);
    let unauthenticatedSince = 0;
    let unavailableSince = 0;
    while (Date.now() < deadline) {
      const health = await this.health();
      if (health.authenticated !== true) {
        unauthenticatedSince ||= Date.now();
        if (Date.now() - unauthenticatedSince >= 30_000) {
          throw new Error("chatgpt_login_required");
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      unauthenticatedSince = 0;
      if (health.extensionConnected !== true || health.pageReady !== true) {
        unavailableSince ||= Date.now();
        if (Date.now() - unavailableSince >= 15_000) {
          throw new Error("chatgpt_browser_unavailable");
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      unavailableSince = 0;
      const slots = Array.isArray(health.slots) ? health.slots : [];
      if (
        slots.some(
          (slot) =>
            slot && typeof slot === "object" && (slot as Record<string, unknown>).state === "idle",
        )
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("chatgpt_browser_unavailable");
  }

  async invoke(definition: QualificationDefinition): Promise<DiagnosticResult> {
    const waitMs = Math.max(0, 90_000 - (Date.now() - this.lastInvocationAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await this.waitForIdleSlot(definition.deadlineMs);
    const jobId = randomUUID();
    const task = TaskContractSchema.parse({
      objective: definition.objective,
      executionChannel: "chatgpt_web",
      model: "chatgpt-web.auto",
      chatgptWeb: {
        mode: definition.mode,
        conversationMode: "temporary_per_request",
        temporaryChat: true,
        personalized: false,
        requireSources: definition.requireSources,
      },
      deadlineMs: definition.deadlineMs,
      budget: { maxOutputTokens: 8_000, maxAttempts: 1 },
    });
    const response = await fetch(new URL("/diagnostic/invoke", this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
        "x-aialra-diagnostic-token": this.diagnosticToken,
      },
      body: JSON.stringify({
        jobId,
        task,
        route: {
          provider: "chatgpt_web",
          model: "chatgpt-web.auto",
          effort: "low",
          policyVersion: "chatgpt-web-qualification-v2",
          reasonCode: "explicit_chatgpt_web_channel",
          sticky: true,
        },
      }),
    });
    if (!response.ok || !response.body) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      throw new Error(payload?.error?.code ?? `chatgpt_browser_unavailable:${response.status}`);
    }
    this.lastInvocationAt = Date.now();
    let outputText = "";
    let errorCode: string | null = null;
    let sources: string[] = [];
    let submittedCount = 0;
    const recoveryCount = 0;
    let temporaryChatVerified = false;
    let failurePhase: ChatGptWebFailurePhase | null = null;
    let diagnosticSummary: ChatGptWebDiagnosticSummary | null = null;
    const lines = createInterface({
      input: Readable.fromWeb(response.body as never),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line) as Record<string, any>;
      const phaseCandidate =
        frame.type === "event" && frame.event?.data?.kind === "chatgpt_web"
          ? ChatGptWebFailurePhaseSchema.safeParse(frame.event?.data?.phase)
          : null;
      if (phaseCandidate?.success) failurePhase = phaseCandidate.data;
      const summaryCandidate = ChatGptWebDiagnosticSummarySchema.safeParse(
        frame.type === "error"
          ? frame.error?.diagnosticSummary
          : frame.event?.data?.diagnosticSummary,
      );
      if (summaryCandidate.success) diagnosticSummary = summaryCandidate.data;
      if (
        frame.type === "event" &&
        frame.event?.data?.kind === "chatgpt_web" &&
        frame.event?.data?.phase === "submitted"
      ) {
        submittedCount += 1;
      }
      if (
        frame.type === "event" &&
        frame.event?.data?.kind === "chatgpt_web" &&
        frame.event?.data?.phase === "temporary_chat_verified"
      ) {
        temporaryChatVerified = true;
      }
      if (frame.type === "error") {
        errorCode = frame.error?.code ?? "chatgpt_web_failed";
        const errorPhase = ChatGptWebFailurePhaseSchema.safeParse(frame.error?.failurePhase);
        if (errorPhase.success) failurePhase = errorPhase.data;
      }
      if (frame.type === "result") {
        outputText = String(frame.result?.outputText ?? "");
        sources = Array.isArray(frame.result?.sources) ? frame.result.sources.map(String) : [];
      }
    }
    if (errorCode)
      throw new DiagnosticInvocationError(
        errorCode,
        submittedCount,
        recoveryCount,
        temporaryChatVerified,
        failurePhase,
        diagnosticSummary,
      );
    if (!outputText) {
      throw new DiagnosticInvocationError(
        "chatgpt_output_incomplete",
        submittedCount,
        recoveryCount,
        temporaryChatVerified,
        failurePhase,
        diagnosticSummary,
      );
    }
    return { outputText, sources, submittedCount, recoveryCount, temporaryChatVerified };
  }
}

function runPassed(run: ChatGptWebQualificationRun): boolean {
  if (run.suite === "readiness") return run.status === "succeeded";
  if (run.suite === "single_probe") {
    const [item] = run.items;
    return Boolean(
      run.total === 1 &&
      run.completed === 1 &&
      run.succeeded === 1 &&
      run.failed === 0 &&
      item?.status === "succeeded" &&
      item.submittedCount === 1 &&
      item.ownershipMatched === true &&
      item.temporaryChatVerified === true,
    );
  }
  const safeSubmissions = run.items.every(
    (item) =>
      item.submittedCount === 1 &&
      item.temporaryChatVerified === true &&
      item.ownershipMatched !== false,
  );
  if (run.suite === "chat_3") return run.succeeded === 3 && safeSubmissions;
  if (run.suite === "chat_10") {
    return run.succeeded >= 9 && safeSubmissions;
  }
  if (run.suite === "deep_2") return run.succeeded === 2 && safeSubmissions;
  const chats = run.items.filter(
    (item) => item.mode === "chat" && item.status === "succeeded",
  ).length;
  const deep = run.items.filter(
    (item) => item.mode === "deep_research" && item.status === "succeeded",
  ).length;
  return run.succeeded >= 9 && chats >= 3 && deep === 2 && safeSubmissions;
}

export async function processChatGptWebQualification(
  repository: JobRepository,
  client: ChatGptWebDiagnosticClient,
  runId: string,
): Promise<void> {
  let run = await repository.findChatGptWebQualificationRun(runId);
  if (!run || run.status !== "accepted") return;
  const startedAt = new Date().toISOString();
  run = await repository.updateChatGptWebQualificationRun(runId, {
    status: "running",
    startedAt,
    errorCode: null,
  });

  if (run.suite === "readiness") {
    const health: Record<string, unknown> = await client.health().catch(() => ({}));
    const passed =
      health.sandboxVerified === true &&
      health.extensionConnected === true &&
      health.pageReady === true &&
      health.authenticated === true &&
      Number(health.quarantinedTabs ?? 0) === 0;
    await repository.updateChatGptWebQualificationRun(runId, {
      status: passed ? "succeeded" : "failed",
      errorCode: passed ? null : "chatgpt_readiness_failed",
      completedAt: new Date().toISOString(),
    });
    return;
  }

  const definitions = definitionsFor(run);
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index]!;
    const runningItems = run.items.map((item, itemIndex) =>
      itemIndex === index ? { ...item, status: "running" as const } : item,
    );
    run = await repository.updateChatGptWebQualificationRun(runId, { items: runningItems });
    const itemStartedAt = Date.now();
    let updatedItem: ChatGptWebQualificationItem;
    try {
      const result = await client.invoke(definition);
      const foreignMarker = /AIALRA_(?:CHAT|SEARCH|DEEP)_\d+_[A-F0-9]{8}/g;
      const markers = result.outputText.match(foreignMarker) ?? [];
      const ownershipMatched =
        result.outputText.includes(definition.marker) &&
        markers.every((value) => value === definition.marker);
      const sourcePassed = !definition.requireSources || result.sources.length > 0;
      const passed =
        ownershipMatched &&
        sourcePassed &&
        result.submittedCount === 1 &&
        result.temporaryChatVerified;
      updatedItem = {
        ...run.items[index]!,
        status: passed ? "succeeded" : "failed",
        durationMs: Date.now() - itemStartedAt,
        outputLength: result.outputText.length,
        outputSha256: createHash("sha256").update(result.outputText).digest("hex"),
        sourceCount: result.sources.length,
        errorCode: passed
          ? null
          : !ownershipMatched
            ? "chatgpt_wrong_task_ownership"
            : !result.temporaryChatVerified
              ? "chatgpt_temporary_chat_unverified"
              : result.submittedCount !== 1
                ? "chatgpt_duplicate_submission"
                : "chatgpt_sources_missing",
        submittedCount: result.submittedCount,
        recoveryCount: result.recoveryCount,
        ownershipMatched,
        temporaryChatVerified: result.temporaryChatVerified,
        failurePhase: null,
        diagnosticSummary: null,
      };
    } catch (error) {
      const failedSubmittedCount =
        error instanceof DiagnosticInvocationError
          ? error.submittedCount
          : run.items[index]!.submittedCount;
      const failedRecoveryCount =
        error instanceof DiagnosticInvocationError
          ? error.recoveryCount
          : run.items[index]!.recoveryCount;
      updatedItem = {
        ...run.items[index]!,
        status: "failed",
        durationMs: Date.now() - itemStartedAt,
        errorCode:
          error instanceof Error
            ? error.message.split(":", 1)[0]!.slice(0, 128)
            : "chatgpt_web_failed",
        submittedCount: failedSubmittedCount,
        recoveryCount: failedRecoveryCount,
        ownershipMatched: null,
        temporaryChatVerified:
          error instanceof DiagnosticInvocationError ? error.temporaryChatVerified : false,
        failurePhase: error instanceof DiagnosticInvocationError ? error.failurePhase : null,
        diagnosticSummary:
          error instanceof DiagnosticInvocationError ? error.diagnosticSummary : null,
      };
    }
    const items = run.items.map((item, itemIndex) => (itemIndex === index ? updatedItem : item));
    const succeeded = items.filter((item) => item.status === "succeeded").length;
    const failed = items.filter((item) => item.status === "failed").length;
    run = await repository.updateChatGptWebQualificationRun(runId, {
      items,
      completed: succeeded + failed,
      succeeded,
      failed,
    });
  }

  const passed = runPassed(run);
  const completedAt = new Date().toISOString();
  run = await repository.updateChatGptWebQualificationRun(runId, {
    status: passed ? "succeeded" : "failed",
    errorCode: passed ? null : "chatgpt_qualification_failed",
    completedAt,
  });
  if (run.suite === "full_10" || run.suite === "single_probe") {
    const status = await repository.readChatGptWebStatus();
    await repository.saveChatGptWebStatus({
      ...status,
      ...(run.suite === "full_10"
        ? {
            circuitState: passed ? "closed" : "qualification_required",
            circuitReason: passed ? null : "qualification_failed",
            effectiveConcurrency: passed && status.configuredEnabled ? 1 : 0,
          }
        : {}),
      temporaryChatVerified: passed,
      lastQualifiedAt: completedAt,
      lastQualificationPassed: passed,
      lastQualificationSucceeded: run.succeeded,
      lastQualificationRunId: run.id,
      updatedAt: completedAt,
    });
  }
}
