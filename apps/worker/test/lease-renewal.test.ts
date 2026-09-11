import { afterEach, describe, expect, it, vi } from "vitest";

import { startLeaseRenewal } from "../src/lease-renewal.js";

afterEach(() => vi.useRealTimers());

describe("ChatGPT web account lease renewal", () => {
  it("renews a live lease repeatedly and stops cleanly", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => true);
    const onLost = vi.fn();
    const stop = startLeaseRenewal(renew, onLost, 1_000);

    await vi.advanceTimersByTimeAsync(3_100);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(onLost).not.toHaveBeenCalled();

    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it("reports lease loss once renewal ownership is gone", async () => {
    vi.useFakeTimers();
    const onLost = vi.fn();
    const stop = startLeaseRenewal(async () => false, onLost, 1_000);

    await vi.advanceTimersByTimeAsync(1_100);
    expect(onLost).toHaveBeenCalledOnce();
    stop();
  });
});
