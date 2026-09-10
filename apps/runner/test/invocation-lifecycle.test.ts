import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { abortInvocationOnDisconnect } from "../src/invocation-lifecycle.js";

class RequestLifecycle extends EventEmitter {
  override once(event: string, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }
}

class ResponseLifecycle extends EventEmitter {
  writableEnded = false;

  override once(event: string, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }
}

describe("runner invocation lifecycle", () => {
  it("aborts when the request body is interrupted", () => {
    const request = new RequestLifecycle();
    const response = new ResponseLifecycle();
    const controller = new AbortController();

    abortInvocationOnDisconnect(request as never, response as never, controller);
    request.emit("aborted");

    expect(controller.signal.aborted).toBe(true);
  });

  it("aborts when the response client disconnects before completion", () => {
    const request = new RequestLifecycle();
    const response = new ResponseLifecycle();
    const controller = new AbortController();

    abortInvocationOnDisconnect(request as never, response as never, controller);
    response.emit("close");

    expect(controller.signal.aborted).toBe(true);
  });

  it("does not abort after a normal completed response closes", () => {
    const request = new RequestLifecycle();
    const response = new ResponseLifecycle();
    const controller = new AbortController();
    response.writableEnded = true;

    abortInvocationOnDisconnect(request as never, response as never, controller);
    response.emit("close");

    expect(controller.signal.aborted).toBe(false);
  });
});
