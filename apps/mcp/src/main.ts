import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { TaskContractSchema } from "@aialra/contracts";
import { ModelRouterClient } from "@aialra/model-router-client";

const baseUrl = process.env.MODEL_ROUTER_URL ?? "http://127.0.0.1:13210";
const apiKey = process.env.MODEL_ROUTER_API_KEY;
if (!apiKey) {
  throw new Error("MODEL_ROUTER_API_KEY is required");
}
const client = new ModelRouterClient({ baseUrl, apiKey });
const server = new McpServer({ name: "aialra-model-router", version: "0.1.0" });

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

const taskInput = {
  objective: z.string().min(1),
  model: z.enum(["auto", "luna", "terra", "sol"]).default("auto"),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).default("medium"),
  task_kind: z
    .enum(["bounded", "coding", "review", "planning", "batch", "general"])
    .default("general"),
  data_classification: z
    .enum(["public", "internal", "confidential", "restricted"])
    .default("internal"),
  deadline_ms: z.number().int().min(1_000).max(3_600_000).default(120_000),
};

server.registerTool(
  "delegate_codex",
  {
    description:
      "Delegate one bounded task to AIALRA Model Router. Child tasks cannot delegate again.",
    inputSchema: taskInput,
  },
  async (input) => {
    const task = TaskContractSchema.parse({
      objective: input.objective,
      model: input.model,
      effort: input.effort,
      taskKind: input.task_kind,
      dataClassification: input.data_classification,
      deadlineMs: input.deadline_ms,
      constraints: ["Do not delegate to another agent."],
    });
    return result(
      await client.createJob(
        { task, metadata: { delegate_depth: "1", child_can_delegate: "false" } },
        randomUUID(),
      ),
    );
  },
);

server.registerTool(
  "preview_route",
  {
    description: "Preview the deterministic route without executing the task.",
    inputSchema: taskInput,
  },
  async (input) =>
    result(
      await client.previewRoute(
        TaskContractSchema.parse({
          objective: input.objective,
          model: input.model,
          effort: input.effort,
          taskKind: input.task_kind,
          dataClassification: input.data_classification,
          deadlineMs: input.deadline_ms,
        }),
      ),
    ),
);

server.registerTool(
  "job_status",
  {
    description: "Read a delegated task and its current terminal or active status.",
    inputSchema: { id: z.string().uuid() },
  },
  async ({ id }) => result(await client.getJob(id)),
);

server.registerTool(
  "cancel_job",
  {
    description: "Cancel a queued or running delegated task.",
    inputSchema: { id: z.string().uuid() },
  },
  async ({ id }) => result(await client.cancelJob(id)),
);

server.registerTool(
  "quota_snapshot",
  { description: "Read the latest Codex quota-window snapshot.", inputSchema: {} },
  async () => result(await client.getQuota()),
);

await server.connect(new StdioServerTransport());
