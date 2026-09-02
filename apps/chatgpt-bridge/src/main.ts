import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { execFile, spawn } from "node:child_process";

import {
  ModelCatalogSnapshotSchema,
  RouteDecisionSchema,
  TaskContractSchema,
  UsageLedgerSchema,
} from "@aialra/contracts";
import { redact } from "@aialra/security";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import { fixedBridgeError, sanitizeSourceUrls } from "./core.js";
import {
  BridgeInvocationSchema,
  ExtensionMessageSchema,
  type BridgeInvocation,
  type BrowserControlDiagnostics,
  type BrowserPageFailureCode,
  type BrowserSlot,
  type ControllerMessage,
} from "./protocol.js";

type PendingInvocation = {
  response: ServerResponse;
  timer: NodeJS.Timeout;
  heartbeat: NodeJS.Timeout;
  startedAt: number;
  settled: boolean;
  nativeActions: Set<string>;
  lastProgressPhase: string | null;
  lastDiagnostics: BrowserControlDiagnostics | null;
};

type PublicDiagnosticSummary = {
  pageKind: BrowserControlDiagnostics["pageKind"];
  userTurnCount: number;
  assistantTurnCount: number;
  latestUserMatchesObjective: boolean | null;
  generationActive: boolean;
  latestAssistantHasText: boolean;
  visibleErrorKinds: BrowserControlDiagnostics["visibleErrorKinds"];
  temporaryChatVerified: boolean;
};

function diagnosticSummary(
  diagnostics: BrowserControlDiagnostics | null,
): PublicDiagnosticSummary | null {
  if (!diagnostics) return null;
  return {
    pageKind: diagnostics.pageKind,
    userTurnCount: diagnostics.userTurnCount,
    assistantTurnCount: diagnostics.assistantTurnCount,
    latestUserMatchesObjective: diagnostics.latestUserMatchesObjective,
    generationActive: diagnostics.generationActive,
    latestAssistantHasText: diagnostics.latestAssistantHasText,
    visibleErrorKinds: diagnostics.visibleErrorKinds,
    temporaryChatVerified:
      diagnostics.temporaryChatEnabled && diagnostics.temporaryChatPersonalized === false,
  };
}

function timeoutCode(entry: PendingInvocation): string {
  const diagnostics = entry.lastDiagnostics;
  if (
    entry.lastProgressPhase === "generating" ||
    entry.lastProgressPhase === "stabilizing" ||
    entry.lastProgressPhase === "user_echo_verified"
  ) {
    if (diagnostics?.latestAssistantHasText) return "chatgpt_output_incomplete";
    if (diagnostics?.visibleErrorKinds.includes("generation_error")) {
      return "chatgpt_page_rendering_failed";
    }
    return "chatgpt_page_generation_blank";
  }
  if (entry.lastProgressPhase === "submitted" || entry.lastProgressPhase === "input_ready") {
    return "chatgpt_delivery_uncertain";
  }
  if (entry.lastProgressPhase) return "chatgpt_page_not_ready";
  return "chatgpt_timeout";
}

const RunnerRequestSchema = z.object({
  jobId: z.string().uuid(),
  attempt: z.number().int().min(1).max(2).default(1),
  task: TaskContractSchema,
  route: RouteDecisionSchema,
});

function requiredEnvironment(name: string): string {
  const secretPath = process.env[`${name}_FILE`];
  if (secretPath && existsSync(secretPath)) return readFileSync(secretPath, "utf8").trim();
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1_000_000) throw new Error("request_too_large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function tokenMatches(candidate: string | null, expected: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

function writeFrame(response: ServerResponse, value: unknown): void {
  response.write(`${JSON.stringify(value)}\n`);
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function x11Environment(): NodeJS.ProcessEnv {
  return { ...process.env, DISPLAY: ":99" };
}

function runXdotool(arguments_: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("xdotool", arguments_, { env: x11Environment(), timeout: 5_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function findChromiumWindow(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "xdotool",
      ["search", "--onlyvisible", "--class", "chromium"],
      { env: x11Environment(), timeout: 5_000, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const windowId = stdout
          .trim()
          .split(/\s+/)
          .filter((candidate) => /^\d+$/.test(candidate))
          .at(-1);
        if (!windowId) reject(new Error("chromium_window_unavailable"));
        else resolve(windowId);
      },
    );
  });
}

async function runFocusedXdotool(arguments_: string[]): Promise<void> {
  const windowId = await findChromiumWindow();
  await runXdotool(["windowactivate", "--sync", windowId]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await runXdotool(arguments_);
}

function startX11Clipboard(
  value: string,
  options: { singleRequest?: boolean } = {},
): Promise<ReturnType<typeof spawn>> {
  return new Promise((resolve, reject) => {
    const arguments_ = ["-selection", "clipboard", "-in", "-quiet"];
    if (options.singleRequest) arguments_.push("-loops", "1");
    const child = spawn("xclip", arguments_, {
      env: x11Environment(),
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("clipboard_start_timeout"));
    }, 3_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.end(value, () => {
      clearTimeout(timer);
      resolve(child);
    });
  });
}

function stopX11Clipboard(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 1_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function waitForClipboardExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      if (child.exitCode === 0) resolve();
      else reject(new Error("clipboard_write_failed"));
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("clipboard_consume_timeout"));
    }, 3_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("clipboard_write_failed"));
    });
  });
}

async function pasteX11Text(value: string, x: number, y: number): Promise<void> {
  const windowId = await findChromiumWindow();
  await runXdotool(["windowactivate", "--sync", windowId]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const clipboard = await startX11Clipboard(value);
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await runXdotool([
      "mousemove",
      String(x),
      String(y),
      "sleep",
      "0.05",
      "click",
      "1",
      "sleep",
      "0.15",
      "key",
      "--clearmodifiers",
      "ctrl+a",
      "key",
      "BackSpace",
      "key",
      "--clearmodifiers",
      "ctrl+v",
    ]);
    // Chromium requests clipboard metadata before it requests the text. Keep
    // the X11 selection owner alive through the complete native paste, then
    // remove the task text before the extension verifies the editor value.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await stopX11Clipboard(clipboard);
  } catch (error) {
    clipboard.kill("SIGKILL");
    throw error;
  }
}

async function clearX11Clipboard(): Promise<void> {
  const clipboard = await startX11Clipboard("", { singleRequest: true });
  // xclip accepts stdin before it necessarily owns the X11 selection. Give
  // the empty owner a brief head start so the one-shot reader cannot win the
  // race and report a false clear failure.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reader = spawn("xclip", ["-selection", "clipboard", "-out"], {
    env: x11Environment(),
    stdio: ["ignore", "ignore", "ignore"],
  });
  await Promise.all([
    waitForClipboardExit(clipboard),
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reader.kill("SIGKILL");
        reject(new Error("clipboard_clear_timeout"));
      }, 3_000);
      reader.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      reader.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("clipboard_clear_failed"));
      });
    }),
  ]);
}

async function main(): Promise<void> {
  const apiToken = requiredEnvironment("CHATGPT_BRIDGE_API_TOKEN");
  const extensionToken =
    process.env.NODE_ENV === "production"
      ? requiredEnvironment("CHATGPT_EXTENSION_TOKEN")
      : (process.env.CHATGPT_EXTENSION_TOKEN ?? "development-only");
  const enabled = process.env.CHATGPT_WEB_ADAPTER_ENABLED === "true";
  const diagnosticEnabled = process.env.CHATGPT_WEB_DIAGNOSTIC_ENABLED === "true";
  const diagnosticToken = diagnosticEnabled
    ? requiredEnvironment("CHATGPT_WEB_DIAGNOSTIC_TOKEN")
    : null;
  const accountId = process.env.CHATGPT_WEB_ACCOUNT_ID ?? "account-a";
  const sandboxVerified = process.env.CHATGPT_CHROMIUM_SANDBOX_VERIFIED === "true";
  const maxConcurrency = 1;
  const minimumDispatchIntervalMs = Math.max(
    1_000,
    Number(process.env.CHATGPT_WEB_MIN_DISPATCH_INTERVAL_MS ?? 90_000),
  );
  const port = Number(process.env.CHATGPT_BRIDGE_PORT ?? 13216);
  const heartbeatMs = Math.max(1_000, Number(process.env.CHATGPT_BRIDGE_HEARTBEAT_MS ?? 15_000));
  const pending = new Map<string, PendingInvocation>();
  const nativeActionQueues = new Map<string, Promise<void>>();
  let extension: WebSocket | null = null;
  let extensionConnectedAt: string | null = null;
  let pageReady = false;
  let authenticated = false;
  let activeTabs = 0;
  let controlDiagnostics: BrowserControlDiagnostics | null = null;
  let browserFailureCode: BrowserPageFailureCode | null = null;
  let browserSlots: BrowserSlot[] = [];
  let quarantinedTabs = 0;
  let adapterVersion = "dom-bridge-v2";
  let phase:
    | "idle"
    | "preparing"
    | "input_verified"
    | "submitted"
    | "generating"
    | "completed"
    | "failed"
    | "resetting" = "idle";
  let activeJobId: string | null = null;
  let activeAttempt: number | null = null;
  let lastHeartbeatAt: string | null = null;
  let lastFailureCode: string | null = null;
  let lastFailureDiagnostics: Record<string, unknown> | null = null;
  let lastResetAt: string | null = null;
  let lastSubmissionAt: string | null = null;
  let temporaryChatVerified = false;

  const failPending = (
    jobId: string,
    code: string,
    message = fixedBridgeError(code),
    diagnostics: BrowserControlDiagnostics | null = null,
  ) => {
    const entry = pending.get(jobId);
    if (!entry || entry.settled) return;
    const failureDiagnostics = diagnostics ?? entry.lastDiagnostics;
    entry.settled = true;
    clearTimeout(entry.timer);
    clearInterval(entry.heartbeat);
    writeFrame(entry.response, {
      type: "error",
      error: {
        code,
        message,
        failurePhase: entry.lastProgressPhase,
        diagnosticSummary: diagnosticSummary(failureDiagnostics),
      },
    });
    entry.response.end();
    pending.delete(jobId);
    if (activeJobId === jobId) {
      phase = "failed";
      activeJobId = null;
      activeAttempt = null;
      lastFailureCode = code;
      lastFailureDiagnostics = failureDiagnostics;
      lastHeartbeatAt = new Date().toISOString();
    }
  };

  const enqueueNativeAction = (jobId: string, operation: () => Promise<void>) => {
    const prior = nativeActionQueues.get(jobId) ?? Promise.resolve();
    const next = prior
      .then(operation)
      .catch(() => failPending(jobId, "chatgpt_delivery_uncertain"))
      .finally(() => {
        if (nativeActionQueues.get(jobId) === next) nativeActionQueues.delete(jobId);
      });
    nativeActionQueues.set(jobId, next);
  };

  const abandonPending = (jobId: string) => {
    const entry = pending.get(jobId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    clearInterval(entry.heartbeat);
    extension?.send(JSON.stringify({ type: "cancel", jobId } satisfies ControllerMessage));
    pending.delete(jobId);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, enabled && extension && pageReady && authenticated ? 200 : 503, {
        status: enabled && extension && pageReady && authenticated ? "ready" : "unavailable",
        service: "aialra-chatgpt-web-bridge",
        accountId,
        enabled,
        diagnosticEnabled,
        sandboxVerified,
        extensionConnected: Boolean(extension),
        pageReady,
        authenticated,
        activeTabs,
        slots: browserSlots,
        quarantinedTabs,
        adapterVersion,
        maxConcurrency,
        pending: pending.size,
        connectedAt: extensionConnectedAt,
        diagnosticsAvailable: Boolean(controlDiagnostics),
        temporaryChatEnabled: controlDiagnostics?.temporaryChatEnabled ?? false,
        temporaryChatPersonalized: controlDiagnostics?.temporaryChatPersonalized ?? null,
        temporaryChatVerified,
        failureCode: browserFailureCode,
        phase,
        activeJobId,
        activeAttempt,
        lastHeartbeatAt,
        lastFailureCode,
        lastResetAt,
        lastSubmissionAt,
      });
      return;
    }
    const bearerAuthorized = authorized(request, apiToken);
    const diagnosticAuthorized =
      url.pathname === "/diagnostic/invoke" &&
      diagnosticEnabled &&
      (isLoopback(request.socket.remoteAddress) || bearerAuthorized) &&
      tokenMatches(
        request.headers["x-aialra-diagnostic-token"]?.toString() ?? null,
        diagnosticToken ?? "",
      );
    if (!bearerAuthorized && !diagnosticAuthorized) {
      json(response, 401, { error: { code: "unauthorized", message: "Unauthorized." } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/models") {
      const snapshot = ModelCatalogSnapshotSchema.parse({
        source: extension && pageReady && authenticated ? "chatgpt-web" : "unavailable",
        fetchedAt: new Date().toISOString(),
        models: [
          { id: "chatgpt-web.auto", displayName: "ChatGPT 网页自动选择", available: true },
        ].map((model) => ({
          ...model,
          provider: "chatgpt_web",
          hidden: false,
          isDefault: model.id === "chatgpt-web.auto",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ["text"],
          creditRate: null,
          apiRate: null,
          rateStatus: "unavailable",
          streamingMode: "final_only",
          discoveredAt: new Date().toISOString(),
        })),
      });
      json(response, 200, snapshot);
      return;
    }
    if (request.method === "GET" && url.pathname === "/diagnostics") {
      json(response, 200, { diagnostics: controlDiagnostics, lastFailureDiagnostics });
      return;
    }
    if (request.method === "POST" && url.pathname === "/probe") {
      if (extension?.readyState !== WebSocket.OPEN) {
        json(response, 503, {
          error: {
            code: "chatgpt_browser_unavailable",
            message: fixedBridgeError("chatgpt_browser_unavailable"),
          },
        });
        return;
      }
      extension.send(
        JSON.stringify({ type: "probe", discoverModels: true } satisfies ControllerMessage),
      );
      json(response, 202, { status: "probing" });
      return;
    }
    const diagnosticRequest = url.pathname === "/diagnostic/invoke";
    if (request.method === "POST" && (url.pathname === "/invoke" || diagnosticRequest)) {
      if (diagnosticRequest) {
        if (!diagnosticAuthorized) {
          json(response, 404, { error: { code: "not_found", message: "Not found." } });
          return;
        }
      } else if (!enabled) {
        json(response, 503, {
          error: { code: "chatgpt_web_disabled", message: "ChatGPT 网页实验通道尚未启用。" },
        });
        return;
      }
      if (browserFailureCode) {
        if (browserFailureCode === "chatgpt_rate_limited") {
          response.setHeader("Retry-After", "1800");
        }
        json(response, browserFailureCode === "chatgpt_rate_limited" ? 429 : 503, {
          error: {
            code: browserFailureCode,
            message: fixedBridgeError(browserFailureCode),
            retryAfter: browserFailureCode === "chatgpt_rate_limited" ? 1800 : null,
          },
        });
        return;
      }
      if (!extension || extension.readyState !== WebSocket.OPEN || !pageReady || !authenticated) {
        json(response, 503, {
          error: {
            code: "chatgpt_browser_unavailable",
            message: fixedBridgeError("chatgpt_browser_unavailable"),
          },
        });
        return;
      }
      if (pending.size >= maxConcurrency) {
        json(response, 429, {
          error: { code: "chatgpt_browser_busy", message: "ChatGPT 网页标签池当前没有空闲位置。" },
        });
        return;
      }
      try {
        const value = RunnerRequestSchema.parse(await readJson(request));
        if (value.route.provider !== "chatgpt_web" || !value.task.chatgptWeb) {
          json(response, 400, {
            error: { code: "invalid_chatgpt_web_task", message: "任务不属于 ChatGPT 网页通道。" },
          });
          return;
        }
        if (pending.has(value.jobId)) {
          json(response, 409, {
            error: { code: "duplicate_browser_job", message: "同一网页任务不能重复发送。" },
          });
          return;
        }
        const elapsedSinceLastSubmission = lastSubmissionAt
          ? Date.now() - new Date(lastSubmissionAt).getTime()
          : minimumDispatchIntervalMs;
        if (elapsedSinceLastSubmission < minimumDispatchIntervalMs) {
          const retryAfter = Math.max(
            1,
            Math.ceil((minimumDispatchIntervalMs - elapsedSinceLastSubmission) / 1_000),
          );
          response.setHeader("Retry-After", String(retryAfter));
          json(response, 429, {
            error: {
              code: "chatgpt_web_pacing_required",
              message: "距离上一次网页发送不足 90 秒，请稍后重试",
              retryAfter,
            },
          });
          return;
        }
        const invocation = BridgeInvocationSchema.parse({
          jobId: value.jobId,
          objective: value.task.objective,
          model: value.route.model,
          mode: value.task.chatgptWeb.mode,
          conversationMode: value.task.chatgptWeb.conversationMode,
          temporaryChat: value.task.chatgptWeb.temporaryChat,
          personalized: value.task.chatgptWeb.personalized,
          requireSources: value.task.chatgptWeb.requireSources,
          deadlineMs: value.task.deadlineMs,
          deadlineAt: Date.now() + value.task.deadlineMs,
          modelLabel: null,
          diagnostic: diagnosticRequest,
          attempt: value.attempt,
        } satisfies BridgeInvocation);
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        });
        const timer = setTimeout(
          () => {
            const entry = pending.get(invocation.jobId);
            extension?.send(
              JSON.stringify({
                type: "cancel",
                jobId: invocation.jobId,
              } satisfies ControllerMessage),
            );
            failPending(invocation.jobId, entry ? timeoutCode(entry) : "chatgpt_timeout");
          },
          Math.max(1, invocation.deadlineAt - Date.now()),
        );
        timer.unref();
        const heartbeat = setInterval(() => {
          if (response.writableEnded || response.destroyed) return;
          writeFrame(response, {
            type: "event",
            event: {
              type: "tool",
              data: {
                kind: "chatgpt_web_heartbeat",
                currentPhase: phase,
                at: new Date().toISOString(),
              },
            },
          });
        }, heartbeatMs);
        heartbeat.unref();
        pending.set(invocation.jobId, {
          response,
          timer,
          heartbeat,
          startedAt: Date.now(),
          settled: false,
          nativeActions: new Set(),
          lastProgressPhase: null,
          lastDiagnostics: null,
        });
        phase = "preparing";
        temporaryChatVerified = false;
        activeJobId = invocation.jobId;
        activeAttempt = invocation.attempt;
        lastHeartbeatAt = new Date().toISOString();
        request.once("aborted", () => abandonPending(invocation.jobId));
        response.once("close", () => abandonPending(invocation.jobId));
        try {
          extension.send(
            JSON.stringify({ type: "invoke", invocation } satisfies ControllerMessage),
          );
        } catch {
          failPending(invocation.jobId, "chatgpt_browser_unavailable");
        }
      } catch (error) {
        if (response.headersSent) {
          response.end();
          return;
        }
        json(response, 400, {
          error: {
            code: "invalid_request",
            message: redact(error instanceof Error ? error.message : String(error)).slice(0, 500),
          },
        });
      }
      return;
    }
    json(response, 404, { error: { code: "not_found", message: "Not found." } });
  });

  const websocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const origin = request.headers.origin ?? "";
    if (
      url.pathname !== "/extension" ||
      !isLoopback(request.socket.remoteAddress) ||
      !origin.startsWith("chrome-extension://") ||
      !tokenMatches(url.searchParams.get("token"), extensionToken)
    ) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (websocket) => {
    extension?.close(1008, "replaced");
    extension = websocket;
    extensionConnectedAt = new Date().toISOString();
    pageReady = false;
    authenticated = false;
    websocket.send(JSON.stringify({ type: "configure" } satisfies ControllerMessage));
    websocket.on("message", (data) => {
      const parsed = ExtensionMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "keepalive") {
        lastHeartbeatAt = new Date().toISOString();
        return;
      }
      if (message.type === "native_reset_request") {
        void runFocusedXdotool([
          "mousemove",
          String(message.x),
          String(message.y),
          "sleep",
          "0.05",
          "click",
          "1",
          "sleep",
          "0.15",
          "key",
          "--clearmodifiers",
          "ctrl+a",
          "key",
          "BackSpace",
        ])
          .then(() =>
            websocket.send(
              JSON.stringify({
                type: "native_reset_result",
                requestId: message.requestId,
                ok: true,
              } satisfies ControllerMessage),
            ),
          )
          .catch(() =>
            websocket.send(
              JSON.stringify({
                type: "native_reset_result",
                requestId: message.requestId,
                ok: false,
              } satisfies ControllerMessage),
            ),
          );
        return;
      }
      if (message.type === "native_click_request" || message.type === "native_input_request") {
        const entry = pending.get(message.jobId);
        if (!entry || entry.settled || entry.nativeActions.size >= 10) {
          failPending(message.jobId, "chatgpt_delivery_uncertain");
          return;
        }
        if (entry.nativeActions.has(message.action)) return;
        entry.nativeActions.add(message.action);
        if (message.type === "native_input_request") {
          enqueueNativeAction(message.jobId, async () => {
            if (message.action === "clear_clipboard") {
              await clearX11Clipboard();
              return;
            }
            if (message.x == null || message.y == null || message.text == null) {
              throw new Error("invalid_native_input");
            }
            await pasteX11Text(message.text, message.x, message.y);
          });
        } else {
          enqueueNativeAction(message.jobId, () =>
            runFocusedXdotool([
              "mousemove",
              String(message.x),
              String(message.y),
              "sleep",
              "0.25",
              "mousedown",
              "1",
              "sleep",
              "0.1",
              "mouseup",
              "1",
            ]),
          );
        }
        return;
      }
      if (message.type === "hello" || message.type === "models") {
        pageReady = message.pageReady;
        authenticated = message.authenticated;
        activeTabs = message.activeTabs;
        browserSlots = message.slots;
        quarantinedTabs = message.quarantinedTabs;
        adapterVersion = message.adapterVersion;
        controlDiagnostics = message.diagnostics ?? null;
        browserFailureCode = message.failureCode ?? null;
        lastHeartbeatAt = new Date().toISOString();
        const slotState = message.slots[0]?.state;
        if (!activeJobId && slotState === "idle") {
          if (phase !== "idle") lastResetAt = new Date().toISOString();
          phase = "idle";
        } else if (slotState === "starting") {
          phase = "resetting";
        }
        return;
      }
      const entry = pending.get(message.jobId);
      if (!entry || entry.settled) return;
      if (message.type === "progress") {
        if (message.diagnostics) entry.lastDiagnostics = message.diagnostics;
        if (entry.lastProgressPhase === message.phase) {
          if (message.diagnostics) {
            writeFrame(entry.response, {
              type: "event",
              event: {
                type: "tool",
                data: {
                  kind: "chatgpt_web_diagnostic",
                  failurePhase: message.phase,
                  diagnosticSummary: diagnosticSummary(message.diagnostics),
                },
              },
            });
          }
          return;
        }
        entry.lastProgressPhase = message.phase;
        phase =
          message.phase === "input_ready"
            ? "input_verified"
            : message.phase === "submitted"
              ? "submitted"
              : message.phase === "user_echo_verified" ||
                  message.phase === "generating" ||
                  message.phase === "stabilizing"
                ? "generating"
                : message.phase === "resetting"
                  ? "resetting"
                  : "preparing";
        lastHeartbeatAt = new Date().toISOString();
        if (message.phase === "temporary_chat_verified") temporaryChatVerified = true;
        if (message.phase === "submitted") lastSubmissionAt = lastHeartbeatAt;
        writeFrame(entry.response, {
          type: "event",
          event: {
            type: "tool",
            data: {
              kind: "chatgpt_web",
              phase: message.phase,
              diagnosticSummary: diagnosticSummary(message.diagnostics ?? null),
            },
          },
        });
      } else if (message.type === "failed") {
        const code = message.code;
        lastFailureDiagnostics = message.diagnostics ?? null;
        const entry = pending.get(message.jobId);
        if (entry && !entry.settled && message.diagnostics) {
          entry.lastDiagnostics = message.diagnostics;
          writeFrame(entry.response, {
            type: "event",
            event: {
              type: "tool",
              data: {
                kind: "chatgpt_web_diagnostic",
                failurePhase: entry.lastProgressPhase,
                diagnosticSummary: diagnosticSummary(message.diagnostics),
              },
            },
          });
        }
        failPending(message.jobId, code, fixedBridgeError(code), message.diagnostics ?? null);
      } else if (message.type === "completed") {
        entry.settled = true;
        clearTimeout(entry.timer);
        clearInterval(entry.heartbeat);
        const sources = sanitizeSourceUrls(message.sources);
        const usage = UsageLedgerSchema.parse({
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          codexCredits: null,
          apiEquivalentUsd: null,
          quotaUsedPercentBefore: null,
          quotaUsedPercentAfter: null,
          quotaWindowDeltaPercent: null,
          allocatedSubscriptionUsd: null,
          measurementStatus: "unavailable",
          subscriptionChannel: "chatgpt_pro_web",
          sourceCount: sources.length,
          durationMs: Date.now() - entry.startedAt,
          attemptCount: activeAttempt ?? 1,
          retryCount: Math.max(0, (activeAttempt ?? 1) - 1),
        });
        writeFrame(entry.response, {
          type: "result",
          result: {
            output: message.outputText,
            outputText: message.outputText,
            threadId: null,
            usage,
            sources,
            conversationUrl: message.conversationUrl,
          },
        });
        entry.response.end();
        pending.delete(message.jobId);
        phase = "completed";
        activeJobId = null;
        activeAttempt = null;
        lastFailureCode = null;
        lastHeartbeatAt = new Date().toISOString();
      }
    });
    websocket.once("close", () => {
      if (extension !== websocket) return;
      extension = null;
      extensionConnectedAt = null;
      pageReady = false;
      authenticated = false;
      activeTabs = 0;
      browserSlots = [];
      quarantinedTabs = 0;
      controlDiagnostics = null;
      browserFailureCode = null;
      for (const jobId of [...pending.keys()]) {
        failPending(jobId, "chatgpt_browser_unavailable");
      }
    });
  });

  server.listen(port, "0.0.0.0");

  const shutdown = () => {
    for (const jobId of [...pending.keys()]) failPending(jobId, "chatgpt_browser_unavailable");
    extension?.close(1001, "shutdown");
    websocketServer.close();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

await main();
