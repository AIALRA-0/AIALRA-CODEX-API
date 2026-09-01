#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const fileIndex = process.argv.indexOf("--results");
const file = fileIndex >= 0 ? process.argv[fileIndex + 1] : undefined;
if (!file) {
  process.stdout.write("Usage: benchmark.mjs --results <completed-jobs.jsonl>\n");
  process.exit(0);
}

const jobs = (await readFile(file, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const accepted = jobs.filter((job) => job.status === "succeeded");
const codexCredits = jobs.reduce((sum, job) => sum + (job.usage?.codexCredits ?? 0), 0);
const report = {
  tasks: jobs.length,
  accepted: accepted.length,
  pass_at_1: jobs.length ? accepted.length / jobs.length : 0,
  validation_failed: jobs.filter(
    (job) => job.status === "failed" && job.error?.code === "validation_failed",
  ).length,
  codex_credits: codexCredits,
  credits_per_accepted_task: accepted.length ? codexCredits / accepted.length : null,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
