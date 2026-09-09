import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { CreateJobRequest } from "@aialra/contracts";

it("passes thinking depth through both CLI entry points with exactly one API request", async () => {
  const requests: CreateJobRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id: "0190abcd-0000-7000-8000-000000000099", status: "queued" }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing_test_address");
  try {
    for (const command of ["call", "research"]) {
      for (const depth of ["Instant", "Medium", "High", "Extra High", "6 Pro"]) {
        const output = await promisify(execFile)(
          process.execPath,
          [
            fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
            fileURLToPath(new URL("../src/main.ts", import.meta.url)),
            command,
            "--channel",
            "chatgpt_web",
            "--task",
            "Synthetic",
            "--thinking-depth",
            depth,
            "--async",
          ],
          {
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              TEMP: process.env.TEMP,
              MODEL_ROUTER_URL: `http://127.0.0.1:${address.port}`,
              MODEL_ROUTER_API_KEY: "synthetic-test-key",
            },
          },
        );
        expect(JSON.parse(output.stdout).status).toBe("queued");
        expect(requests.at(-1)?.task.chatgptWeb).toMatchObject({
          thinkingDepth: depth,
          temporaryChat: true,
          personalized: false,
          conversationMode: "temporary_per_request",
        });
      }
    }
    expect(requests).toHaveLength(10);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30_000);
