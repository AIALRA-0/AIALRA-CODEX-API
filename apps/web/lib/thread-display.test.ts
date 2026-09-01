import { describe, expect, it } from "vitest";

import { threadExpiryLabel, truncateSessionKey } from "./thread-display";

describe("truncateSessionKey", () => {
  it("截断过长的线程标识并追加省略号", () => {
    expect(truncateSessionKey("sess-abcdef1234567890")).toBe("sess-abcdef1…");
  });

  it("短标识原样返回", () => {
    expect(truncateSessionKey("sess-123")).toBe("sess-123");
  });
});

describe("threadExpiryLabel", () => {
  const now = new Date("2026-08-28T12:00:00Z");

  it("剩余超过一小时时按小时显示", () => {
    expect(threadExpiryLabel("2026-08-29T05:30:00Z", now)).toBe("约 18 小时后到期");
  });

  it("不足一小时时按分钟显示", () => {
    expect(threadExpiryLabel("2026-08-28T12:20:00Z", now)).toBe("约 20 分钟后到期");
  });

  it("已经过期的线程显示已到期", () => {
    expect(threadExpiryLabel("2026-08-28T11:59:59Z", now)).toBe("已到期");
  });

  it("无法解析的时间按已到期处理", () => {
    expect(threadExpiryLabel("not-a-date", now)).toBe("已到期");
  });
});
