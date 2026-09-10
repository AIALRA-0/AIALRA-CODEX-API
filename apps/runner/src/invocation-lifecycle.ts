import type { IncomingMessage, ServerResponse } from "node:http";

type RequestLifecycle = Pick<IncomingMessage, "once">;
type ResponseLifecycle = Pick<ServerResponse, "once" | "writableEnded">;

export function abortInvocationOnDisconnect(
  request: RequestLifecycle,
  response: ResponseLifecycle,
  controller: AbortController,
): void {
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
}
