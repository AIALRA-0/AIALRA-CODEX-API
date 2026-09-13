import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../extension/service-worker.js", import.meta.url), "utf8");

function harness() {
  const pendingProgressAcks = new Map();
  const timers = new Map<number, () => void>();
  const send = vi.fn();
  const sendResponse = vi.fn();
  let nextTimer = 0;
  const sendSubmittedProgressWithAck = runInNewContext(
    `${source.slice(
      source.indexOf("function sendSubmittedProgressWithAck("),
      source.indexOf("function publicSlots("),
    )}; sendSubmittedProgressWithAck`,
    {
      crypto: { randomUUID: () => "0190abcd-0000-7000-8000-000000000123" },
      pendingProgressAcks,
      send,
      setTimeout: (callback: () => void) => {
        const id = ++nextTimer;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  return { pendingProgressAcks, timers, send, sendResponse, sendSubmittedProgressWithAck };
}

describe("submitted progress acknowledgement", () => {
  it("resends only the progress frame, then acknowledges once", () => {
    const h = harness();
    h.sendSubmittedProgressWithAck(
      { jobId: "fixture-job", phase: "submitted", diagnostics: null },
      h.sendResponse,
    );
    expect(h.send).toHaveBeenCalledOnce();
    const frame = h.send.mock.calls[0]?.[0];
    expect(frame).toMatchObject({
      type: "progress",
      phase: "submitted",
      requestId: "0190abcd-0000-7000-8000-000000000123",
    });
    h.timers.get(1)?.();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1]?.[0]).toEqual(frame);
    h.pendingProgressAcks.get(frame.requestId)?.settle(true);
    expect(h.sendResponse).toHaveBeenCalledOnce();
    expect(h.sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(h.pendingProgressAcks.size).toBe(0);
    expect(h.timers.size).toBe(0);
  });

  it("returns uncertainty if the controller never acknowledges", () => {
    const h = harness();
    h.sendSubmittedProgressWithAck({ jobId: "fixture-job", phase: "submitted" }, h.sendResponse);
    h.timers.get(2)?.();
    expect(h.sendResponse).toHaveBeenCalledOnce();
    expect(h.sendResponse).toHaveBeenCalledWith({ ok: false });
    expect(h.pendingProgressAcks.size).toBe(0);
  });
});
