import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { TaskContractSchema } from "@aialra/contracts";

const children: ChildProcess[] = [];

async function waitUntilReady(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === 503 || response.ok) return;
    } catch {
      // The child process may still be starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("bridge_start_timeout");
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
});

describe("ChatGPT web bridge server", () => {
  it("authenticates the extension, discovers models and returns one final-only result", async () => {
    const port = 18_000 + Math.floor(Math.random() * 2_000);
    const tsxCli = fileURLToPath(
      new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const source = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const child = spawn(process.execPath, [tsxCli, source], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        CHATGPT_WEB_ADAPTER_ENABLED: "true",
        CHATGPT_BRIDGE_PORT: String(port),
        CHATGPT_BRIDGE_HEARTBEAT_MS: "1000",
        CHATGPT_BRIDGE_API_TOKEN: "synthetic-api-token",
        CHATGPT_EXTENSION_TOKEN: "synthetic-extension-token",
      },
      stdio: "ignore",
    });
    children.push(child);
    await waitUntilReady(`http://127.0.0.1:${port}/healthz`);

    const extension = new WebSocket(
      `ws://127.0.0.1:${port}/extension?token=synthetic-extension-token`,
      { origin: "chrome-extension://synthetic-test" },
    );
    await new Promise<void>((resolve, reject) => {
      extension.once("open", resolve);
      extension.once("error", reject);
    });
    extension.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        pageReady: true,
        authenticated: true,
        models: [{ id: "", displayName: "GPT-5 Pro", available: true }],
        activeTabs: 0,
        diagnostics: {
          composerFound: true,
          temporaryChatEnabled: true,
          modelControlFound: true,
          toolsControlFound: true,
          selectedSend: {
            tag: "button",
            testId: "composer-submit-button",
            ariaLabel: "Send prompt",
            role: null,
            buttonType: "button",
            disabled: false,
          },
          sameRowControls: [],
          pageKind: "home",
          surface: "chat",
          assistantTurnCount: 0,
          blankAssistantTurnCount: 0,
          latestAssistantHasText: false,
          generationActive: false,
        },
      }),
    );

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${port}/diagnostics`, {
      headers: { authorization: "Bearer synthetic-api-token" },
    });
    expect(await diagnosticsResponse.json()).toMatchObject({
      diagnostics: { composerFound: true, temporaryChatEnabled: true },
      lastFailureDiagnostics: null,
    });

    const modelResponse = await fetch(`http://127.0.0.1:${port}/models`, {
      headers: { authorization: "Bearer synthetic-api-token" },
    });
    const catalog = (await modelResponse.json()) as { models: Array<{ id: string }> };
    expect(catalog.models.map((model) => model.id)).toEqual(["chatgpt-web.auto"]);

    const jobId = "0190abcd-0000-7000-8000-000000000001";
    const task = TaskContractSchema.parse({
      objective: "Return SYNTHETIC_OK",
      executionChannel: "chatgpt_web",
      model: "chatgpt-web.auto",
      chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
      deadlineMs: 10_000,
      budget: { maxOutputTokens: 1_000, maxAttempts: 1 },
    });
    const invokeResponse = fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-api-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jobId,
        task,
        route: {
          provider: "chatgpt_web",
          model: "chatgpt-web.auto",
          effort: "low",
          policyVersion: "test",
          reasonCode: "explicit_chatgpt_web_channel",
          sticky: true,
        },
      }),
    });
    const controllerMessage = await nextMessage(extension);
    expect(controllerMessage.type).toBe("invoke");
    expect((controllerMessage.invocation as { modelLabel: string | null }).modelLabel).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    extension.send(
      JSON.stringify({
        type: "completed",
        jobId,
        outputText: "SYNTHETIC_OK",
        sources: [],
        conversationUrl: "https://chatgpt.com/c/synthetic",
      }),
    );

    const response = await invokeResponse;
    expect(response.status).toBe(200);
    const frames = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(frames.at(-1)).toMatchObject({
      type: "result",
      result: {
        outputText: "SYNTHETIC_OK",
        usage: { measurementStatus: "unavailable", subscriptionChannel: "chatgpt_pro_web" },
      },
    });
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "event",
        event: {
          type: "tool",
          data: expect.objectContaining({
            kind: "chatgpt_web_heartbeat",
            currentPhase: expect.any(String),
          }),
        },
      }),
    );
    expect(
      frames.find((frame) => frame.event?.data?.kind === "chatgpt_web_heartbeat")?.event?.data,
    ).not.toHaveProperty("phase");
    extension.close();
  });

  it("allows one loopback diagnostic while the production adapter stays disabled", async () => {
    const port = 20_000 + Math.floor(Math.random() * 2_000);
    const tsxCli = fileURLToPath(
      new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const source = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const child = spawn(process.execPath, [tsxCli, source], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        CHATGPT_WEB_ADAPTER_ENABLED: "false",
        CHATGPT_WEB_DIAGNOSTIC_ENABLED: "true",
        CHATGPT_WEB_DIAGNOSTIC_TOKEN: "synthetic-diagnostic-token",
        CHATGPT_WEB_DEFAULT_MODEL_LABEL: "GPT-5 Pro",
        CHATGPT_BRIDGE_PORT: String(port),
        CHATGPT_BRIDGE_API_TOKEN: "synthetic-api-token",
        CHATGPT_EXTENSION_TOKEN: "synthetic-extension-token",
      },
      stdio: "ignore",
    });
    children.push(child);
    await waitUntilReady(`http://127.0.0.1:${port}/healthz`);

    const extension = new WebSocket(
      `ws://127.0.0.1:${port}/extension?token=synthetic-extension-token`,
      { origin: "chrome-extension://synthetic-test" },
    );
    await new Promise<void>((resolve, reject) => {
      extension.once("open", resolve);
      extension.once("error", reject);
    });
    extension.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        pageReady: true,
        authenticated: true,
        models: [{ id: "", displayName: "GPT-5 Pro", available: true }],
        activeTabs: 0,
      }),
    );

    const jobId = "0190abcd-0000-7000-8000-000000000002";
    const task = TaskContractSchema.parse({
      objective: "Return SYNTHETIC_DIAGNOSTIC_OK",
      executionChannel: "chatgpt_web",
      model: "chatgpt-web.auto",
      chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
      deadlineMs: 10_000,
      budget: { maxOutputTokens: 1_000, maxAttempts: 1 },
    });
    const payload = JSON.stringify({
      jobId,
      task,
      route: {
        provider: "chatgpt_web",
        model: "chatgpt-web.auto",
        effort: "low",
        policyVersion: "test",
        reasonCode: "explicit_chatgpt_web_channel",
        sticky: true,
      },
    });

    const productionResponse = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-api-token",
        "content-type": "application/json",
      },
      body: payload,
    });
    expect(productionResponse.status).toBe(503);
    expect(await productionResponse.json()).toMatchObject({
      error: { code: "chatgpt_web_disabled" },
    });

    const diagnosticResponse = fetch(`http://127.0.0.1:${port}/diagnostic/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aialra-diagnostic-token": "synthetic-diagnostic-token",
      },
      body: payload,
    });
    const controllerMessage = await nextMessage(extension);
    expect(controllerMessage.type).toBe("invoke");
    expect((controllerMessage.invocation as { diagnostic: boolean }).diagnostic).toBe(true);
    expect((controllerMessage.invocation as { modelLabel: string | null }).modelLabel).toBeNull();
    extension.send(
      JSON.stringify({
        type: "completed",
        jobId,
        outputText: "SYNTHETIC_DIAGNOSTIC_OK",
        sources: [],
        conversationUrl: "https://chatgpt.com/c/synthetic-diagnostic",
      }),
    );

    const response = await diagnosticResponse;
    expect(response.status).toBe(200);
    expect((await response.text()).trim()).toContain("SYNTHETIC_DIAGNOSTIC_OK");
    extension.close();
  });
});
