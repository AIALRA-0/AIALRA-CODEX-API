import { describe, expect, it } from "vitest";

import { getRemainingPercent } from "./quota-display";

describe("getRemainingPercent", () => {
  it("优先使用官方返回的剩余比例", () => {
    expect(getRemainingPercent(72.5, 20)).toBe(72.5);
  });

  it("缺少剩余比例时根据已用比例计算", () => {
    expect(getRemainingPercent(null, 27.5)).toBe(72.5);
  });

  it("把异常比例限制在 0 到 100", () => {
    expect(getRemainingPercent(120, null)).toBe(100);
    expect(getRemainingPercent(null, 120)).toBe(0);
  });

  it("没有额度读数时返回空值", () => {
    expect(getRemainingPercent(null, null)).toBeNull();
  });
});
