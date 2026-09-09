import { describe, expect, it } from "vitest";
import { availableCodexEfforts, effortLabel } from "./model-efforts";

describe("discovered Codex efforts", () => {
  const models = [
    {
      id: "one",
      provider: "codex",
      available: true,
      enabled: true,
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "two",
      provider: "codex",
      available: true,
      enabled: true,
      supportedReasoningEfforts: ["medium", "future"],
    },
    {
      id: "web",
      provider: "chatgpt_web",
      available: true,
      enabled: true,
      supportedReasoningEfforts: ["not-codex"],
    },
  ];
  it("includes max and future capabilities instead of a fixed four-level list", () => {
    expect(availableCodexEfforts(models, "auto")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "future",
    ]);
    expect(effortLabel("max")).toBe("最高（max）");
    expect(effortLabel("future")).toBe("future");
  });
  it("uses only the selected enabled model and never invents unavailable choices", () => {
    expect(availableCodexEfforts(models, "two")).toEqual(["medium", "future"]);
    expect(
      availableCodexEfforts(
        models.map((m) => ({ ...m, enabled: false })),
        "auto",
      ),
    ).toEqual([]);
    expect(availableCodexEfforts([], "auto")).toEqual([]);
  });
});
