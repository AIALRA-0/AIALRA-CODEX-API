import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ChatGptWebQualificationRunSchema,
  type ChatGptWebQualificationItem,
} from "@aialra/contracts";
import { InMemoryJobRepository } from "@aialra/persistence";

import {
  ChatGptWebDiagnosticClient,
  DiagnosticInvocationError,
  processChatGptWebQualification,
} from "../src/chatgpt-qualification.js";

function items(count: number): ChatGptWebQualificationItem[] {
  return Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    name: `chat-${index + 1}`,
    mode: "chat",
    status: "pending",
    durationMs: null,
    outputLength: null,
    outputSha256: null,
    sourceCount: null,
    errorCode: null,
    submittedCount: 0,
    recoveryCount: 0,
    ownershipMatched: null,
    temporaryChatVerified: false,
  }));
}

describe("ChatGPT web qualification", () => {
  it("waits through a transient unauthenticated browser snapshot", async () => {
    vi.useFakeTimers();
    try {
      const client = new ChatGptWebDiagnosticClient(
        "http://127.0.0.1:1",
        "synthetic-api",
        "synthetic-diagnostic",
      );
      vi.spyOn(client, "health")
        .mockResolvedValueOnce({
          authenticated: false,
          extensionConnected: true,
          pageReady: false,
          slots: [],
        })
        .mockResolvedValue({
          authenticated: true,
          extensionConnected: true,
          pageReady: true,
          slots: [{ state: "idle" }],
        });

      const waiting = (
        client as unknown as { waitForIdleSlot(deadlineMs: number): Promise<void> }
      ).waitForIdleSlot(5_000);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(waiting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a three-chat gate successful without storing the response body", async () => {
    const repository = new InMemoryJobRepository();
    const now = new Date().toISOString();
    const run = ChatGptWebQualificationRunSchema.parse({
      id: randomUUID(),
      suite: "chat_3",
      status: "accepted",
      total: 3,
      completed: 0,
      succeeded: 0,
      failed: 0,
      items: items(3),
      errorCode: null,
      createdBy: "admin",
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    });
    await repository.createChatGptWebQualificationRun(run);
    const client = new ChatGptWebDiagnosticClient(
      "http://127.0.0.1:1",
      "synthetic-api",
      "synthetic-diagnostic",
    );
    vi.spyOn(client, "invoke").mockImplementation(
      async (definition: Parameters<ChatGptWebDiagnosticClient["invoke"]>[0]) => ({
        outputText: `合成回答 ${definition.marker}`,
        sources: [],
        submittedCount: 1,
        recoveryCount: 0,
        temporaryChatVerified: true,
      }),
    );

    await processChatGptWebQualification(repository, client, run.id);
    const saved = await repository.findChatGptWebQualificationRun(run.id);

    expect(saved).toMatchObject({ status: "succeeded", completed: 3, succeeded: 3, failed: 0 });
    expect(
      saved?.items.every((item) => item.outputSha256 && !JSON.stringify(item).includes("合成回答")),
    ).toBe(true);
  });

  it("passes a single probe only after Temporary Chat and ownership are verified", async () => {
    const repository = new InMemoryJobRepository();
    const now = new Date().toISOString();
    const run = ChatGptWebQualificationRunSchema.parse({
      id: randomUUID(),
      suite: "single_probe",
      status: "accepted",
      total: 1,
      completed: 0,
      succeeded: 0,
      failed: 0,
      items: items(1),
      errorCode: null,
      createdBy: "admin",
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    });
    await repository.createChatGptWebQualificationRun(run);
    const client = new ChatGptWebDiagnosticClient(
      "http://127.0.0.1:1",
      "synthetic-api",
      "synthetic-diagnostic",
    );
    vi.spyOn(client, "invoke").mockImplementation(
      async (definition: Parameters<ChatGptWebDiagnosticClient["invoke"]>[0]) => ({
        outputText: `合成回答 ${definition.marker}`,
        sources: [],
        submittedCount: 1,
        recoveryCount: 0,
        temporaryChatVerified: true,
      }),
    );

    await processChatGptWebQualification(repository, client, run.id);
    const saved = await repository.findChatGptWebQualificationRun(run.id);

    expect(saved).toMatchObject({ status: "succeeded", total: 1, completed: 1, succeeded: 1 });
    expect(saved?.items[0]).toMatchObject({
      submittedCount: 1,
      ownershipMatched: true,
      temporaryChatVerified: true,
    });
    expect((await repository.readChatGptWebStatus()).configuredEnabled).toBe(false);
  });

  it("does not pass a single probe when Temporary Chat evidence is absent", async () => {
    const repository = new InMemoryJobRepository();
    const now = new Date().toISOString();
    const run = ChatGptWebQualificationRunSchema.parse({
      id: randomUUID(),
      suite: "single_probe",
      status: "accepted",
      total: 1,
      completed: 0,
      succeeded: 0,
      failed: 0,
      items: items(1),
      errorCode: null,
      createdBy: "admin",
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    });
    await repository.createChatGptWebQualificationRun(run);
    const client = new ChatGptWebDiagnosticClient(
      "http://127.0.0.1:1",
      "synthetic-api",
      "synthetic-diagnostic",
    );
    vi.spyOn(client, "invoke").mockImplementation(
      async (definition: Parameters<ChatGptWebDiagnosticClient["invoke"]>[0]) => ({
        outputText: `合成回答 ${definition.marker}`,
        sources: [],
        submittedCount: 1,
        recoveryCount: 0,
        temporaryChatVerified: false,
      }),
    );

    await processChatGptWebQualification(repository, client, run.id);
    expect((await repository.findChatGptWebQualificationRun(run.id))?.status).toBe("failed");
  });

  it("persists only the safe failure phase and diagnostic summary", async () => {
    const repository = new InMemoryJobRepository();
    const now = new Date().toISOString();
    const run = ChatGptWebQualificationRunSchema.parse({
      id: randomUUID(),
      suite: "single_probe",
      status: "accepted",
      total: 1,
      completed: 0,
      succeeded: 0,
      failed: 0,
      items: items(1),
      errorCode: null,
      createdBy: "admin",
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    });
    await repository.createChatGptWebQualificationRun(run);
    const client = new ChatGptWebDiagnosticClient(
      "http://127.0.0.1:1",
      "synthetic-api",
      "synthetic-diagnostic",
    );
    vi.spyOn(client, "invoke").mockRejectedValue(
      new DiagnosticInvocationError("chatgpt_page_generation_blank", 1, 0, true, "generating", {
        pageKind: "home",
        userTurnCount: 1,
        assistantTurnCount: 0,
        latestUserMatchesObjective: true,
        generationActive: false,
        latestAssistantHasText: false,
        visibleErrorKinds: [],
        temporaryChatVerified: true,
      }),
    );

    await processChatGptWebQualification(repository, client, run.id);
    const saved = await repository.findChatGptWebQualificationRun(run.id);

    expect(saved?.items[0]).toMatchObject({
      errorCode: "chatgpt_page_generation_blank",
      submittedCount: 1,
      failurePhase: "generating",
      diagnosticSummary: {
        pageKind: "home",
        userTurnCount: 1,
        assistantTurnCount: 0,
        latestUserMatchesObjective: true,
        temporaryChatVerified: true,
      },
    });
    expect(JSON.stringify(saved)).not.toContain("prompt");
    expect(JSON.stringify(saved)).not.toContain("conversationUrl");
  });
});
