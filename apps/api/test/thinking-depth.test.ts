import "reflect-metadata";
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { TaskContractSchema } from "@aialra/contracts";
import { ChatCompletionsController } from "../src/chat/chat.controller.js";
import { ResponsesController } from "../src/responses/responses.controller.js";
import type { JobsService } from "../src/jobs/jobs.service.js";
import type { AuthenticatedRequest } from "../src/common/api-key.guard.js";

describe("web thinking depth compatibility", () => {
  const cases = ["chat", "responses"].flatMap((kind) =>
    ["chat", "search", "deep_research"].flatMap((mode) =>
      ["Instant", "Medium", "High", "Extra High", "6 Pro"].flatMap((depth) =>
        [false, true].map((stream) => ({ kind, mode, depth, stream })),
      ),
    ),
  );
  it.each(cases)(
    "maps $kind / $mode / $depth / stream=$stream without changing the label",
    async ({ kind, mode, depth, stream }) => {
      const stop = new Error("captured-before-queue");
      const create = vi.fn().mockRejectedValue(stop);
      const jobs = { create } as unknown as JobsService;
      const controller =
        kind === "chat" ? new ChatCompletionsController(jobs) : new ResponsesController(jobs);
      const body = {
        model: "chatgpt-web.auto",
        stream,
        aialra: {
          thinking_depth: depth,
          chatgpt_mode: mode,
          ...(mode === "deep_research" ? { deep_research_persistence_acknowledged: true } : {}),
        },
        ...(kind === "chat"
          ? { messages: [{ role: "user", content: "Synthetic" }] }
          : { input: "Synthetic" }),
      };
      await expect(
        controller.create(
          body,
          { header: () => "synthetic-key" } as unknown as AuthenticatedRequest,
          {} as Response,
        ),
      ).rejects.toBe(stop);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]?.[0].task.chatgptWeb).toMatchObject({
        thinkingDepth: depth,
        mode,
        temporaryChat: mode !== "deep_research",
        personalized: mode === "deep_research",
        persistenceAcknowledged: mode === "deep_research",
        conversationMode:
          mode === "deep_research" ? "persistent_per_request" : "temporary_per_request",
      });
    },
  );

  it("keeps the field optional and rejects invalid labels", () => {
    const base = {
      objective: "Synthetic",
      executionChannel: "chatgpt_web",
      chatgptWeb: { mode: "chat" },
    };
    expect(TaskContractSchema.parse(base).chatgptWeb?.thinkingDepth).toBeUndefined();
    for (const thinkingDepth of ["", " ", "x".repeat(65)]) {
      expect(
        TaskContractSchema.safeParse({ ...base, chatgptWeb: { ...base.chatgptWeb, thinkingDepth } })
          .success,
      ).toBe(false);
    }
  });
});
