import { readFile } from "node:fs/promises";

const baseUrl = (process.env.CHATGPT_BRIDGE_URL ?? "http://127.0.0.1:13216").replace(/\/$/, "");
const tokenFile = process.env.CHATGPT_BRIDGE_API_TOKEN_FILE;
const expectedEnabled = process.env.EXPECTED_ADAPTER_ENABLED === "true";

const token =
  process.env.CHATGPT_BRIDGE_API_TOKEN?.trim() ??
  (tokenFile ? (await readFile(tokenFile, "utf8")).trim() : "");

if (!token) {
  console.error("CHATGPT_BRIDGE_API_TOKEN or CHATGPT_BRIDGE_API_TOKEN_FILE is required");
  process.exit(2);
}

async function readJson(path, authorized = false) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: authorized ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json();
  if (!response.ok && path !== "/healthz") {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return payload;
}

const [health, diagnosticEnvelope, catalog] = await Promise.all([
  readJson("/healthz"),
  readJson("/diagnostics", true),
  readJson("/models", true),
]);

const diagnostics = diagnosticEnvelope.diagnostics;
const checks = {
  adapterStateMatches: health.enabled === expectedEnabled,
  extensionConnected: health.extensionConnected === true,
  pageReady: health.pageReady === true,
  authenticated: health.authenticated === true,
  idle: health.activeTabs === 0 && health.pending === 0,
  noVisibleFailure: health.failureCode === null,
  composerFound: diagnostics?.composerFound === true,
  modelControlFound: diagnostics?.modelControlFound === true,
  toolsControlFound: diagnostics?.toolsControlFound === true,
  sendControlFound:
    Boolean(diagnostics?.selectedSend) && diagnostics.selectedSend.disabled === false,
  modelCatalogFound: Array.isArray(catalog.models) && catalog.models.length > 0,
};

const report = {
  passed: Object.values(checks).every(Boolean),
  checkedAt: new Date().toISOString(),
  productionTasksSent: 0,
  checks,
  page: diagnostics
    ? {
        pageKind: diagnostics.pageKind,
        surface: diagnostics.surface,
        temporaryChatEnabled: diagnostics.temporaryChatEnabled,
        assistantTurnCount: diagnostics.assistantTurnCount,
        blankAssistantTurnCount: diagnostics.blankAssistantTurnCount,
        latestAssistantHasText: diagnostics.latestAssistantHasText,
        generationActive: diagnostics.generationActive,
      }
    : null,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.passed ? 0 : 1);
