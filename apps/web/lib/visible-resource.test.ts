import { describe, expect, it, vi } from "vitest";
import { readVisibleResource } from "./visible-resource";

describe("visible resource reads", () => {
  it("publishes successful reads", async () => {
    const receive = vi.fn();
    const fail = vi.fn();
    await readVisibleResource(async () => 42, undefined, receive, fail);
    expect(receive).toHaveBeenCalledWith(42);
    expect(fail).not.toHaveBeenCalled();
  });

  it("reports genuine failures instead of leaving an unhandled rejection", async () => {
    const fail = vi.fn();
    const error = new Error("HTTP 503");
    await readVisibleResource(
      async () => {
        throw error;
      },
      undefined,
      vi.fn(),
      fail,
    );
    expect(fail).toHaveBeenCalledWith(error);
  });

  it("does not report navigation cancellation as an error", async () => {
    const controller = new AbortController();
    const fail = vi.fn();
    await readVisibleResource(
      async () => {
        controller.abort();
        throw new DOMException("Cancelled", "AbortError");
      },
      controller.signal,
      vi.fn(),
      fail,
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it("ignores a late result after the page has left", async () => {
    const controller = new AbortController();
    const receive = vi.fn();
    await readVisibleResource(
      async () => {
        controller.abort();
        return 42;
      },
      controller.signal,
      receive,
      vi.fn(),
    );
    expect(receive).not.toHaveBeenCalled();
  });
});
