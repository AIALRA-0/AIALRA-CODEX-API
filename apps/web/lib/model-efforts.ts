interface EffortModel {
  id: string;
  provider?: string;
  available: boolean;
  enabled: boolean;
  supportedReasoningEfforts: string[];
}

export function availableCodexEfforts(models: EffortModel[], modelId: string): string[] {
  return [
    ...new Set(
      models
        .filter(
          (model) =>
            (model.provider ?? "codex") === "codex" &&
            model.available &&
            model.enabled &&
            (modelId === "auto" || model.id === modelId),
        )
        .flatMap((model) => model.supportedReasoningEfforts),
    ),
  ];
}

export function effortLabel(effort: string): string {
  const labels: Record<string, string> = {
    minimal: "最低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最高",
  };
  return labels[effort] ? `${labels[effort]}（${effort}）` : effort;
}
