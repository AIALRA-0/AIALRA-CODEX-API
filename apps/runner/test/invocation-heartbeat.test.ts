import { afterEach, describe, expect, it, vi } from "vitest";

import { startInvocationHeartbeat } from "../src/invocation-heartbeat.js";

afterEach(() => vi.useRealTimers());

describe("runner invocation heartbeat", () => {
  it("flushes headers immediately and emits transport-only frames while the response is open", () => {
    vi.useFakeTimers();
    const response = {
      destroyed: false,
      writableEnded: false,
      flushHeaders: vi.fn(),
      write: vi.fn(),
    };

    const stop = startInvocationHeartbeat(response as never, 1_000);
    expect(response.flushHeaders).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(3_000);
    expect(response.write).toHaveBeenCalledTimes(3);
    expect(String(response.write.mock.calls[0]?.[0])).toContain('"type":"heartbeat"');

    stop();
    vi.advanceTimersByTime(2_000);
    expect(response.write).toHaveBeenCalledTimes(3);
  });
});
