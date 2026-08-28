import { describe, expect, it } from "vitest";

import { TaskContractSchema } from "../src/index.js";

describe("TaskContractSchema", () => {
  it("applies secure defaults", () => {
    const task = TaskContractSchema.parse({ objective: "Classify this message" });

    expect(task.permissions.filesystem).toBe("read");
    expect(task.permissions.network).toBe("none");
    expect(task.model).toBe("auto");
    expect(task.deadlineMs).toBe(120_000);
  });

  it("rejects unbounded deadlines", () => {
    expect(() =>
      TaskContractSchema.parse({ objective: "Run forever", deadlineMs: 3_600_001 }),
    ).toThrow();
  });
});
