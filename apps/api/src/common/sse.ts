import type { Response } from "express";

/** Stop polling disconnected consumers without cancelling their durable job. */
export function openEventStream(response: Response) {
  const controller = new AbortController();
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  const close = () => {
    clearInterval(heartbeat);
    response.off("close", close);
    controller.abort();
  };
  const heartbeat = setInterval(() => {
    if (response.destroyed || response.writableEnded) close();
    else response.write(": keep-alive\n\n");
  }, 15_000);
  heartbeat.unref();
  response.once("close", close);
  return { signal: controller.signal, close };
}
