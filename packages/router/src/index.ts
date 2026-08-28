import type { QuotaSnapshot, RouteDecision, TaskContract } from "@aialra/contracts";

export interface RoutingPolicy {
  version: string;
  normalMaxUsedPercent: number;
  constrainedMaxUsedPercent: number;
  reserveAtUsedPercent: number;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  version: "1.0.0",
  normalMaxUsedPercent: 70,
  constrainedMaxUsedPercent: 85,
  reserveAtUsedPercent: 95,
};

const CODEX_MODEL_IDS = {
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
  sol: "gpt-5.6-sol",
} as const;

function automaticCodexModel(task: TaskContract): keyof typeof CODEX_MODEL_IDS {
  if (task.risk >= 3 || task.ambiguity >= 3 || task.taskKind === "planning") {
    return "sol";
  }

  if (
    task.taskKind === "bounded" ||
    task.taskKind === "batch" ||
    (task.validation.responseSchema && task.ambiguity <= 1)
  ) {
    return "luna";
  }

  return "terra";
}

export function selectRoute(
  task: TaskContract,
  quota: QuotaSnapshot | null,
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): RouteDecision {
  if (task.model !== "auto") {
    const model =
      task.model === "luna" || task.model === "terra" || task.model === "sol"
        ? CODEX_MODEL_IDS[task.model]
        : task.model;
    return {
      provider: "codex",
      model,
      effort: task.effort,
      policyVersion: policy.version,
      reasonCode: "explicit_codex_model",
      sticky: true,
    };
  }

  const usedPercent = quota?.usedPercent ?? 0;
  const model = automaticCodexModel(task);
  if (usedPercent >= policy.reserveAtUsedPercent && model !== "luna") {
    throw new Error("codex_capacity_reserved");
  }
  if (usedPercent >= policy.constrainedMaxUsedPercent && model !== "luna") {
    throw new Error("codex_capacity_constrained");
  }

  return {
    provider: "codex",
    model: CODEX_MODEL_IDS[model],
    effort: task.effort,
    policyVersion: policy.version,
    reasonCode:
      usedPercent >= policy.normalMaxUsedPercent ? `quota_guard_${model}` : `task_profile_${model}`,
    sticky: true,
  };
}
