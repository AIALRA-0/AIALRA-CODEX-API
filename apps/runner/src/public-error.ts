export type RunnerErrorPhase = "request" | "execution" | "quota" | "models";

export type RunnerExecutionError = {
  code:
    | "codex_auth_expired"
    | "codex_auth_failed"
    | "codex_quota_exhausted"
    | "codex_provider_timeout"
    | "codex_provider_unavailable"
    | "runner_failed";
  message: string;
};

const PUBLIC_MESSAGES: Record<RunnerErrorPhase, string> = {
  request: "Runner rejected the request.",
  execution: "Codex execution failed.",
  quota: "Quota data is temporarily unavailable.",
  models: "Model catalog is temporarily unavailable.",
};

export function runnerPublicMessage(phase: RunnerErrorPhase): string {
  return PUBLIC_MESSAGES[phase];
}

export function classifyRunnerExecutionError(error: unknown): RunnerExecutionError {
  const message = error instanceof Error ? error.message : String(error);
  if (/token[_ ]expired|authentication token (?:is |has )?expired/i.test(message)) {
    return { code: "codex_auth_expired", message: "Codex authentication has expired." };
  }
  if (
    /\b401\b|unauthori[sz]ed|authentication failed|login required|sign[ -]?in required/i.test(
      message,
    )
  ) {
    return { code: "codex_auth_failed", message: "Codex authentication failed." };
  }
  if (
    /quota.{0,32}(?:exhausted|reached)|usage limit|credits?.{0,16}(?:exhausted|depleted)/i.test(
      message,
    )
  ) {
    return { code: "codex_quota_exhausted", message: "Codex quota is exhausted." };
  }
  if (/timed? ?out|timeout|deadline exceeded/i.test(message)) {
    return { code: "codex_provider_timeout", message: "Codex provider timed out." };
  }
  if (
    /\b503\b|service unavailable|provider unavailable|app[_ ]server[_ ]exited|ECONN|network/i.test(
      message,
    )
  ) {
    return { code: "codex_provider_unavailable", message: "Codex provider is unavailable." };
  }
  return { code: "runner_failed", message: runnerPublicMessage("execution") };
}
