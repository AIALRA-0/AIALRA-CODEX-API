import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ChatGptWebQualificationRunSchema,
  type ChatGptWebQualificationItem,
} from "@aialra/contracts";
import { InMemoryJobRepository } from "@aialra/persistence";

import {
  ChatGptWebDiagnosticClient,
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
      }),
    );

    await processChatGptWebQualification(repository, client, run.id);
    const saved = await repository.findChatGptWebQualificationRun(run.id);

    expect(saved).toMatchObject({ status: "succeeded", completed: 3, succeeded: 3, failed: 0 });
    expect(
      saved?.items.every((item) => item.outputSha256 && !JSON.stringify(item).includes("合成回答")),
    ).toBe(true);
  });
});
