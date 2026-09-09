import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import type { CreateJobRequest } from "@aialra/contracts";

it("passes every discovered depth through a real MCP stdio session without resubmission", async () => {
  const requests: CreateJobRequest[] = [];
  const keys: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      keys.push(String(request.headers["idempotency-key"]));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id: "0190abcd-0000-7000-8000-000000000099", status: "queued" }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing_test_address");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
    ],
    env: {
      MODEL_ROUTER_URL: `http://127.0.0.1:${address.port}`,
      MODEL_ROUTER_API_KEY: "synthetic-test-key",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "thinking-depth-test", version: "1" });
  try {
    await client.connect(transport);
    for (const mode of ["chat", "search", "deep_research"]) {
      for (const depth of ["Instant", "Medium", "High", "Extra High", "6 Pro"]) {
        const result = await client.callTool({
          name: "delegate_chatgpt",
          arguments: { objective: "Synthetic", mode, thinking_depth: depth },
        });
        expect(result.isError).not.toBe(true);
        expect(requests.at(-1)?.task.chatgptWeb).toMatchObject({
          mode,
          thinkingDepth: depth,
          temporaryChat: true,
          personalized: false,
          conversationMode: "temporary_per_request",
        });
      }
    }
    expect(requests).toHaveLength(15);
    expect(new Set(keys).size).toBe(15);
    expect(keys).not.toContain("undefined");
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);
