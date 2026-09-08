import { describe, expect, it } from "vitest";

import { codexEnvironment } from "../src/environment.js";
import { classifyRunnerExecutionError, runnerPublicMessage } from "../src/public-error.js";

describe("runner boundary", () => {
  it("does not inherit control-plane secrets", () => {
    const result = codexEnvironment({
      PATH: "/usr/bin",
      CODEX_HOME: "/codex-auth",
      DATABASE_URL: "synthetic-database-value",
      PAYLOAD_MASTER_KEY: "synthetic-master-key",
      API_KEY_PEPPER: "synthetic-pepper",
      RUNNER_API_TOKEN: "synthetic-runner-token",
    });
    expect(result.PATH).toBe("/usr/bin");
    expect(result.CODEX_HOME).toBe("/codex-auth");
    expect(result).not.toHaveProperty("DATABASE_URL");
    expect(result).not.toHaveProperty("PAYLOAD_MASTER_KEY");
    expect(result).not.toHaveProperty("API_KEY_PEPPER");
    expect(result).not.toHaveProperty("RUNNER_API_TOKEN");
  });

  it("returns fixed public errors instead of internal exception text", () => {
    const sensitiveInternalError = "database_password=synthetic-secret";
    const publicMessages = (["request", "execution", "quota", "models"] as const).map((phase) =>
      runnerPublicMessage(phase),
    );

    expect(publicMessages).not.toContain(sensitiveInternalError);
    expect(publicMessages.every((message) => !message.includes("synthetic-secret"))).toBe(true);
  });

  it("classifies Codex authentication, quota, timeout, and availability failures", () => {
    expect(classifyRunnerExecutionError(new Error("401 token_expired"))).toEqual({
      code: "codex_auth_expired",
      message: "Codex authentication has expired.",
    });
    expect(classifyRunnerExecutionError(new Error("401 Unauthorized"))).toMatchObject({
      code: "codex_auth_failed",
    });
    expect(classifyRunnerExecutionError(new Error("usage limit reached"))).toMatchObject({
      code: "codex_quota_exhausted",
    });
    expect(classifyRunnerExecutionError(new Error("request timed out"))).toMatchObject({
      code: "codex_provider_timeout",
    });
    expect(classifyRunnerExecutionError(new Error("503 service unavailable"))).toMatchObject({
      code: "codex_provider_unavailable",
    });
    expect(classifyRunnerExecutionError(new Error("unknown internal failure"))).toMatchObject({
      code: "runner_failed",
    });
  });
});
