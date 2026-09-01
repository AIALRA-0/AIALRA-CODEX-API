import { describe, expect, it } from "vitest";

import { getJobResultSummary } from "./job-review";

describe("getJobResultSummary", () => {
  it("explains a deterministic validation failure", () => {
    const summary = getJobResultSummary({
      status: "failed",
      errorCode: "validation_failed",
      errorMessage: "The output did not match.",
      validation: {
        passed: false,
        schemaPassed: null,
        testsPassed: 0,
        testsFailed: 1,
        messages: ['equals_failed:expected="ROUTER_E2E_OK":actual="OTHER"'],
      },
    });

    expect(summary?.label).toBe("规则检查失败");
    expect(summary?.details[0]).toContain("ROUTER_E2E_OK");
  });

  it("distinguishes execution approval from output validation", () => {
    const summary = getJobResultSummary({
      status: "awaiting_approval",
      errorCode: null,
      errorMessage: null,
      validation: null,
    });

    expect(summary?.label).toBe("等待授权");
    expect(summary?.title).toBe("尚未开始执行");
  });

  it("returns no review summary for successful calls", () => {
    expect(
      getJobResultSummary({
        status: "succeeded",
        errorCode: null,
        errorMessage: null,
        validation: null,
      }),
    ).toBeNull();
  });
});
