export type RunnerErrorPhase = "request" | "execution" | "quota" | "models";

const PUBLIC_MESSAGES: Record<RunnerErrorPhase, string> = {
  request: "Runner rejected the request.",
  execution: "Codex execution failed.",
  quota: "Quota data is temporarily unavailable.",
  models: "Model catalog is temporarily unavailable.",
};

export function runnerPublicMessage(phase: RunnerErrorPhase): string {
  return PUBLIC_MESSAGES[phase];
}
