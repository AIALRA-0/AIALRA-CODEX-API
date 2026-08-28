#!/usr/bin/env node

import { randomUUID } from "node:crypto";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv.includes("--help")) {
  process.stdout.write(
    "Usage: invoke.mjs --task <objective> [--model auto] [--effort medium] [--preview]\n",
  );
  process.exit(0);
}

const baseUrl = (process.env.MODEL_ROUTER_URL ?? "http://127.0.0.1:13210").replace(/\/$/, "");
const apiKey = process.env.MODEL_ROUTER_API_KEY;
const objective = argument("--task");
if (!apiKey || !objective) {
  throw new Error("MODEL_ROUTER_API_KEY and --task are required");
}

const task = {
  objective,
  taskKind: argument("--kind", "general"),
  model: argument("--model", "auto"),
  effort: argument("--effort", "medium"),
  deadlineMs: Number(argument("--deadline-ms", "120000")),
};
const preview = process.argv.includes("--preview");
const response = await fetch(`${baseUrl}${preview ? "/api/v1/routes/preview" : "/api/v1/jobs"}`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "idempotency-key": argument("--idempotency-key", randomUUID()),
  },
  body: JSON.stringify(preview ? { task } : { task, metadata: { source: "skill" } }),
});
const value = await response.json();
if (!response.ok) {
  throw new Error(JSON.stringify(value));
}
process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
