import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { TaskContractSchema } from "@aialra/contracts";

import {
  buildTaskPrompt,
  calculateApiEquivalentUsd,
  calculateCodexCredits,
  codexFilesystemPermissionOverride,
  modelCatalogFromAppServer,
  quotaSnapshotFromAppServer,
} from "../src/index.js";

const task = TaskContractSchema.parse({
  objective: "Classify the message",
  taskKind: "bounded",
});

describe("provider utilities", () => {
  it("builds a bounded prompt without delegation permission", () => {
    const prompt = buildTaskPrompt(task);
    expect(prompt).toContain("Do not delegate");
    expect(prompt).toContain("Classify the message");
  });

  it("calculates Codex subscription credits", () => {
    expect(calculateCodexCredits("gpt-5.6-luna", 10_000, 2_000, 1_000)).toBeCloseTo(0.071);
  });

  it("calculates the equivalent token price at official API rates", () => {
    expect(calculateApiEquivalentUsd("gpt-5.6-luna", 10_000, 2_000, 1_000)).toBeCloseTo(0.00284);
  });

  it("normalizes App Server rate-limit snapshots", () => {
    const snapshot = quotaSnapshotFromAppServer({
      rateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      },
      planType: "pro",
    });
    expect(snapshot.usedPercent).toBe(42);
    expect(snapshot.windowDurationMinutes).toBe(300);
    expect(snapshot.planType).toBe("pro");
    expect(snapshot.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "codex:primary", remainingPercent: 58 }),
      ]),
    );
  });

  it("keeps every named App Server quota window separate", () => {
    const snapshot = quotaSnapshotFromAppServer({
      rateLimits: { primary: { usedPercent: 10 } },
      rateLimitsByLimitId: {
        weekly: { limitName: "周限制", primary: { usedPercent: 25 } },
        spark: { limitName: "Spark", secondary: { usedPercent: 40 } },
      },
    });
    expect(snapshot.windows.map((window) => window.id)).toEqual([
      "codex:primary",
      "weekly:primary",
      "spark:secondary",
    ]);
  });

  it("normalizes the runtime model catalog", () => {
    const catalog = modelCatalogFromAppServer({
      data: [
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "high", description: "Thorough" },
            { reasoningEffort: "future", description: "Unknown" },
          ],
          inputModalities: ["text", "image"],
        },
      ],
    });
    expect(catalog.models[0]).toMatchObject({
      id: "gpt-5.5",
      available: true,
      supportedReasoningEfforts: ["low", "high"],
      inputModalities: ["text", "image"],
    });
  });

  it("supports published rate cards and leaves Spark unknown", () => {
    expect(calculateCodexCredits("gpt-5.5", 1_000_000, 0, 0)).toBe(125);
    expect(calculateApiEquivalentUsd("gpt-5.4-mini", 1_000_000, 0, 0)).toBe(0.75);
    expect(calculateCodexCredits("gpt-5.3-codex-spark", 1_000, 0, 1_000)).toBeNull();
  });

  it("denies the Codex identity directory in every task profile", () => {
    const override = codexFilesystemPermissionOverride("/codex-auth", "/workspace/job-1", "read");
    expect(override).toContain(`"${resolve("/codex-auth").replaceAll("\\", "/")}"="deny"`);
    expect(override).toContain(`"${resolve("/workspace/job-1").replaceAll("\\", "/")}"="read"`);
    expect(override).toContain(`":root"="read"`);
    expect(override).toContain(`"${resolve("/run/secrets").replaceAll("\\", "/")}"="deny"`);
    expect(override).toContain(`"${resolve("/proc").replaceAll("\\", "/")}"="deny"`);
  });

  it("does not expose a workspace when filesystem permission is none", () => {
    const override = codexFilesystemPermissionOverride("/codex-auth", "/workspace/job-2", "none");
    expect(override).not.toContain(`"${resolve("/workspace/job-2").replaceAll("\\", "/")}"=`);
  });
});
