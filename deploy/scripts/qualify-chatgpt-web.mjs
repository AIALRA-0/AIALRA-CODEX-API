import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const endpoint = process.env.CHATGPT_BRIDGE_URL ?? "http://127.0.0.1:13216";
const tokenFile =
  process.env.CHATGPT_WEB_DIAGNOSTIC_TOKEN_FILE ?? "/run/secrets/chatgpt_web_diagnostic_token";
const invokePath = process.env.CHATGPT_QUALIFICATION_INVOKE_PATH ?? "/diagnostic/invoke";
const intervalMs = Number(process.env.CHATGPT_QUALIFICATION_INTERVAL_MS ?? 45_000);
const failFast = process.env.CHATGPT_QUALIFICATION_FAIL_FAST === "true";
let observedSubmittedExactlyOnce = true;
let observedWrongOwnership = false;

const tests = [
  {
    label: "chat-01",
    mode: "chat",
    temporaryChat: true,
    requireSources: false,
    deadlineMs: 180_000,
    marker: "AIALRA_Q_CHAT_01_8D2F",
    objective: "计算 37 乘以 41，用一句中文说明结果，并在最后单独输出 AIALRA_Q_CHAT_01_8D2F",
  },
  {
    label: "chat-02",
    mode: "chat",
    temporaryChat: true,
    requireSources: false,
    deadlineMs: 180_000,
    marker: "AIALRA_Q_CHAT_02_41B7",
    objective:
      "把 capacity-aware routing 翻译成自然中文，用一句话说明含义，并在最后单独输出 AIALRA_Q_CHAT_02_41B7",
  },
  {
    label: "chat-03",
    mode: "chat",
    temporaryChat: true,
    requireSources: false,
    deadlineMs: 180_000,
    marker: "AIALRA_Q_CHAT_03_C9A1",
    objective:
      "将分类、抽取、摘要按中文拼音首字母排序，只输出排序结果和最后一行 AIALRA_Q_CHAT_03_C9A1",
  },
  {
    label: "chat-04",
    mode: "chat",
    temporaryChat: true,
    requireSources: false,
    deadlineMs: 180_000,
    marker: "AIALRA_Q_CHAT_04_E3C6",
    objective: "用不超过 40 个中文字符解释幂等键的用途，并在最后单独输出 AIALRA_Q_CHAT_04_E3C6",
  },
  {
    label: "search-01",
    mode: "search",
    temporaryChat: true,
    requireSources: true,
    deadlineMs: 300_000,
    marker: "AIALRA_Q_SEARCH_01_72AC",
    objective:
      "仅依据 OpenAI 官方文档，确认 Codex SDK 当前提供哪些编程语言版本，用一句话回答并附来源，最后单独输出 AIALRA_Q_SEARCH_01_72AC，不要提问",
  },
  {
    label: "search-02",
    mode: "search",
    temporaryChat: true,
    requireSources: true,
    deadlineMs: 300_000,
    marker: "AIALRA_Q_SEARCH_02_B551",
    objective:
      "仅依据 OpenAI 官方文档，说明 Codex CLI 的一次性非交互命令名称，用一句话回答并附来源，最后单独输出 AIALRA_Q_SEARCH_02_B551，不要提问",
  },
  {
    label: "search-03",
    mode: "search",
    temporaryChat: true,
    requireSources: true,
    deadlineMs: 300_000,
    marker: "AIALRA_Q_SEARCH_03_9F04",
    objective:
      "仅依据 Tailscale 官方文档，用一句话说明 Split DNS 的用途并附来源，最后单独输出 AIALRA_Q_SEARCH_03_9F04，不要提问",
  },
  {
    label: "search-04",
    mode: "search",
    temporaryChat: true,
    requireSources: true,
    deadlineMs: 300_000,
    marker: "AIALRA_Q_SEARCH_04_6E8B",
    objective:
      "仅依据 Authentik 官方文档，用一句话说明 Passkey 登录需要的核心组件并附来源，最后单独输出 AIALRA_Q_SEARCH_04_6E8B，不要提问",
  },
  {
    label: "deep-01",
    mode: "deep_research",
    temporaryChat: true,
    requireSources: true,
    deadlineMs: 3_600_000,
    marker: "AIALRA_Q_DEEP_01_5A73",
    objective:
      "做一份不超过 700 个中文字符的深度研究：仅依据 W3C、NIST、CISA 和 Google 官方资料，比较 WebAuthn Passkey 与 TOTP 用于私有管理后台登录时的抗钓鱼能力、恢复方式和部署复杂度；给出三点结论和来源；不要向我提问；最后单独输出 AIALRA_Q_DEEP_01_5A73",
  },
  {
    label: "deep-02",
    mode: "deep_research",
    temporaryChat: true,
    requireSources: true,
    deadlineMs: 3_600_000,
    marker: "AIALRA_Q_DEEP_02_D014",
    objective:
      "做一份不超过 700 个中文字符的深度研究：仅依据 Chrome、OWASP 和 noVNC 官方资料，列出可见浏览器自动化桥接服务的五项主要安全边界，并说明每项应如何验证；给出来源；不要向我提问；最后单独输出 AIALRA_Q_DEEP_02_D014",
  },
];
const startAt = Math.max(1, Number(process.env.CHATGPT_QUALIFICATION_START_AT ?? 1));
const endAt = Math.min(
  tests.length,
  Number(process.env.CHATGPT_QUALIFICATION_END_AT ?? tests.length),
);

function writeRecord(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readHealth() {
  const response = await fetch(`${endpoint}/healthz`);
  return { status: response.status, body: await response.json() };
}

async function waitForReadyHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = await readHealth();
  while (Date.now() < deadline) {
    if (
      latest.body.diagnosticEnabled &&
      latest.body.extensionConnected &&
      latest.body.pageReady &&
      latest.body.authenticated &&
      latest.body.pending === 0 &&
      latest.body.activeTabs === 0
    ) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    latest = await readHealth();
  }
  return latest;
}

async function runTest(token, test, index) {
  const before = await waitForReadyHealth();
  if (
    !before.body.diagnosticEnabled ||
    !before.body.extensionConnected ||
    !before.body.pageReady ||
    !before.body.authenticated ||
    before.body.pending !== 0 ||
    before.body.activeTabs !== 0
  ) {
    writeRecord({
      type: "qualification",
      index: index + 1,
      label: test.label,
      mode: test.mode,
      passed: false,
      errorCode: "bridge_not_ready",
      healthStatus: before.body.status,
    });
    return false;
  }

  const jobId = randomUUID();
  const task = {
    objective: test.objective,
    executionChannel: "chatgpt_web",
    model: "chatgpt-web.auto",
    chatgptWeb: {
      mode: test.mode,
      conversationMode: "temporary_per_request",
      temporaryChat: test.temporaryChat,
      personalized: false,
      requireSources: test.requireSources,
    },
    deadlineMs: test.deadlineMs,
    sessionMode: "ephemeral",
    budget: { maxOutputTokens: 8_192, maxAttempts: 1 },
  };
  const route = {
    provider: "chatgpt_web",
    model: "chatgpt-web.auto",
    effort: "low",
    policyVersion: "qualification-2026-08-31",
    reasonCode: "explicit_chatgpt_web_channel",
    sticky: true,
  };
  const startedAt = Date.now();

  try {
    const response = await fetch(`${endpoint}${invokePath}`, {
      method: "POST",
      headers: {
        "x-aialra-diagnostic-token": token,
        authorization: `Bearer ${process.env.CHATGPT_BRIDGE_API_TOKEN ?? "diagnostic-only"}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jobId, task, route }),
    });
    const raw = await response.text();
    if (!response.ok) {
      let errorCode = `http_${response.status}`;
      try {
        errorCode = JSON.parse(raw).error?.code ?? errorCode;
      } catch {
        // The status code remains the only safe diagnostic for an invalid JSON response
      }
      writeRecord({
        type: "qualification",
        index: index + 1,
        label: test.label,
        mode: test.mode,
        passed: false,
        httpStatus: response.status,
        errorCode,
        elapsedMs: Date.now() - startedAt,
      });
      return false;
    }

    const frames = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const phases = frames
      .filter((frame) => frame.type === "event")
      .map((frame) => frame.event?.data?.phase)
      .filter(Boolean);
    const errors = frames.filter((frame) => frame.type === "error");
    const diagnostics = frames
      .filter((frame) => frame.event?.data?.kind === "chatgpt_web_diagnostic")
      .at(-1)?.event?.data;
    const terminal = frames.findLast((frame) => frame.type === "result");
    const output = terminal?.result?.outputText ?? "";
    const sourceCount = Number(
      terminal?.result?.usage?.sourceCount ?? terminal?.result?.sources?.length ?? 0,
    );
    const markerMatched = output.includes(test.marker);
    const foreignMarkerMatched = tests.some(
      (candidate) => candidate.marker !== test.marker && output.includes(candidate.marker),
    );
    const submittedCount = phases.filter((phase) => phase === "submitted").length;
    observedSubmittedExactlyOnce &&= submittedCount === 1;
    observedWrongOwnership ||= foreignMarkerMatched;
    const passed =
      Boolean(terminal) &&
      errors.length === 0 &&
      markerMatched &&
      !foreignMarkerMatched &&
      submittedCount === 1 &&
      (!test.requireSources || sourceCount > 0);

    writeRecord({
      type: "qualification",
      index: index + 1,
      label: test.label,
      mode: test.mode,
      passed,
      terminal: terminal ? "result" : (errors[0]?.error?.code ?? "missing_terminal"),
      markerMatched,
      foreignMarkerMatched,
      submittedCount,
      sourceCount,
      phaseCount: phases.length,
      phases,
      outputLength: output.length,
      outputSha256: output ? createHash("sha256").update(output).digest("hex") : null,
      durationMs: terminal?.result?.usage?.durationMs ?? Date.now() - startedAt,
      temporaryChat: test.temporaryChat,
      diagnostics: diagnostics
        ? {
            pageKind: diagnostics.pageKind,
            surface: diagnostics.surface,
            assistantTurnCount: diagnostics.assistantTurnCount,
            blankAssistantTurnCount: diagnostics.blankAssistantTurnCount,
            generationActive: diagnostics.generationActive,
            userTurnCount: diagnostics.userTurnCount,
            latestUserTextLength: diagnostics.latestUserTextLength,
            expectedUserTextLength: diagnostics.expectedUserTextLength,
            latestUserMatchesObjective: diagnostics.latestUserMatchesObjective,
            latestAssistant: diagnostics.latestAssistant,
          }
        : null,
    });
    return passed;
  } catch (error) {
    writeRecord({
      type: "qualification",
      index: index + 1,
      label: test.label,
      mode: test.mode,
      passed: false,
      errorCode: String(error instanceof Error ? error.message : error).slice(0, 160),
      elapsedMs: Date.now() - startedAt,
    });
    return false;
  }
}

async function main() {
  const token = (await readFile(tokenFile, "utf8")).trim();
  let passed = 0;
  let chatPassed = 0;
  let deepPassed = 0;
  const initialHealth = await readHealth();
  const connectedAt = initialHealth.body.connectedAt ?? null;
  const selected = tests.slice(startAt - 1, endAt);
  for (const [offset, test] of selected.entries()) {
    const index = startAt - 1 + offset;
    const testPassed = await runTest(token, test, index);
    if (testPassed) passed += 1;
    if (testPassed && test.mode === "chat") chatPassed += 1;
    if (testPassed && test.mode === "deep_research") deepPassed += 1;
    if (!testPassed && failFast) break;
    if (offset < selected.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  const fullSuite = startAt === 1 && endAt === tests.length;
  const finalHealth = await readHealth();
  const browserRestarted = connectedAt !== (finalHealth.body.connectedAt ?? null);
  const qualificationPassed =
    fullSuite &&
    passed >= 9 &&
    chatPassed >= 3 &&
    deepPassed === 2 &&
    observedSubmittedExactlyOnce &&
    !observedWrongOwnership &&
    !browserRestarted;
  writeRecord({
    type: "summary",
    startAt,
    endAt,
    total: selected.length,
    passed,
    failed: selected.length - passed,
    minimumPassed: 9,
    chatPassed,
    deepPassed,
    submittedExactlyOnce: observedSubmittedExactlyOnce,
    wrongOwnership: observedWrongOwnership,
    browserRestarted,
    qualificationPassed: fullSuite ? qualificationPassed : null,
  });
  process.exitCode = fullSuite && !qualificationPassed ? 1 : 0;
}

await main();
