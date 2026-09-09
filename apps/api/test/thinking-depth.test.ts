import "reflect-metadata";
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { TaskContractSchema } from "@aialra/contracts";
import { ChatCompletionsController } from "../src/chat/chat.controller.js";
import { ResponsesController } from "../src/responses/responses.controller.js";
import type { JobsService } from "../src/jobs/jobs.service.js";
import type { AuthenticatedRequest } from "../src/common/api-key.guard.js";

describe("web thinking depth compatibility", () => {
  it.each(["chat", "responses"])("passes the discovered label intact through %s", async (kind) => {
    const stop = new Error("captured-before-queue");
    const create = vi.fn().mockRejectedValue(stop);
    const jobs = { create } as unknown as JobsService;
    const controller =
      kind === "chat" ? new ChatCompletionsController(jobs) : new ResponsesController(jobs);
    const body = {
      model: "chatgpt-web.auto",
      aialra: { thinking_depth: "Heavy" },
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
    expect(create.mock.calls[0]?.[0].task.chatgptWeb.thinkingDepth).toBe("Heavy");
  });

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
