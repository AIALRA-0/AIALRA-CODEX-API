import type { ServerResponse } from "node:http";

export const DEFAULT_RUNNER_HEARTBEAT_MS = 15_000;

export function startInvocationHeartbeat(
  response: Pick<ServerResponse, "destroyed" | "flushHeaders" | "writableEnded" | "write">,
  intervalMs = DEFAULT_RUNNER_HEARTBEAT_MS,
): () => void {
  response.flushHeaders();
  const timer = setInterval(
    () => {
      if (response.destroyed || response.writableEnded) return;
      response.write(`${JSON.stringify({ type: "heartbeat", at: new Date().toISOString() })}\n`);
    },
    Math.max(1_000, intervalMs),
  );
  timer.unref();
  return () => clearInterval(timer);
}
