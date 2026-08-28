import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { TaskContractSchema } from "@aialra/contracts";

import {
  buildTaskPrompt,
  calculateApiEquivalentUsd,
  calculateCodexCredits,
  codexFilesystemPermissionOverride,
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
