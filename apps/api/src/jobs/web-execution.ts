import type { Job, JobEvent, WebExecutionSummary } from "@aialra/contracts";

/** Build a safe, evidence-backed summary from the events of one web job. */
export function summarizeWebExecution(job: Job, events: JobEvent[]): WebExecutionSummary {
  let accountId: string | null = null;
  let resolvedThinkingDepth: string | null = null;

  for (const event of events) {
    if (event.type !== "tool") continue;
    const data = event.data;
    if (data.kind === "chatgpt_web_account_assigned" && typeof data.accountId === "string") {
      accountId = data.accountId;
      resolvedThinkingDepth = null;
      continue;
    }
    if (
      data.kind !== "chatgpt_web" ||
      !["mode_selected", "submitted", "user_echo_verified", "generating", "stabilizing"].includes(
        String(data.phase),
      )
    )
      continue;
    if (typeof data.accountId === "string" && accountId !== data.accountId) {
      accountId = data.accountId;
      resolvedThinkingDepth = null;
    }
    const diagnostic = data.diagnosticSummary;
    if (!diagnostic || typeof diagnostic !== "object") continue;
    const depth = (diagnostic as Record<string, unknown>).resolvedThinkingDepth;
    if (typeof depth === "string" && depth.length > 0) resolvedThinkingDepth = depth;
  }

  return {
    accountId,
    requestedThinkingDepth: job.task.chatgptWeb?.thinkingDepth ?? null,
    resolvedThinkingDepth,
    thinkingDepthVerified:
      resolvedThinkingDepth !== null &&
      (!job.task.chatgptWeb?.thinkingDepth ||
        job.task.chatgptWeb.thinkingDepth === resolvedThinkingDepth),
  };
}
