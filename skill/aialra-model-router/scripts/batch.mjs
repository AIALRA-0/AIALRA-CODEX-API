#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const fileIndex = process.argv.indexOf("--file");
const file = fileIndex >= 0 ? process.argv[fileIndex + 1] : undefined;
const baseUrl = (process.env.MODEL_ROUTER_URL ?? "http://127.0.0.1:13210").replace(/\/$/, "");
const apiKey = process.env.MODEL_ROUTER_API_KEY;
if (!file || !apiKey) {
  throw new Error("MODEL_ROUTER_API_KEY and --file are required");
}

const requests = (await readFile(file, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
if (requests.length < 1 || requests.length > 100) {
  throw new Error("A batch must contain between 1 and 100 JSONL requests");
}

const response = await fetch(`${baseUrl}/api/v1/batches`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "idempotency-key": `skill-batch-${randomUUID()}`,
  },
  body: JSON.stringify({ requests }),
});
const value = await response.json();
if (!response.ok) {
  throw new Error(JSON.stringify(value));
}
process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
