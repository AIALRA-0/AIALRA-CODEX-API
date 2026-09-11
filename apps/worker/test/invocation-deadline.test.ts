import { afterEach, describe, expect, it, vi } from "vitest";

import { InvocationDeadline } from "../src/invocation-deadline.js";

afterEach(() => vi.useRealTimers());

describe("invocation deadline", () => {
  it("does not consume generation time before capacity is assigned", async () => {
    vi.useFakeTimers();
    const deadline = new InvocationDeadline(1_000);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(deadline.signal.aborted).toBe(false);

    deadline.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(deadline.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.signal.aborted).toBe(true);
  });
});
