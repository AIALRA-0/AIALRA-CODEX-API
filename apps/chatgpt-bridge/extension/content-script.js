const CONTENT_SCRIPT_MARKER = "data-aialra-chatgpt-bridge-active";
const primaryContentScript = !document.documentElement.hasAttribute(CONTENT_SCRIPT_MARKER);
if (primaryContentScript) document.documentElement.setAttribute(CONTENT_SCRIPT_MARKER, "true");
const DOCUMENT_TOKEN = crypto.randomUUID();

const SELECTORS = {
  composer: [
    "#prompt-textarea",
    "[data-testid='composer-text-input']",
    "main [contenteditable='true'][role='textbox']",
  ],
  send: [
    "button[data-testid='send-button']",
    "button[data-testid='composer-submit-button']",
    "form button[type='submit']",
    "button[aria-label*='send' i]",
    "button[aria-label*='发送']",
  ],
  stop: [
    "button[data-testid='stop-button']",
    "button[aria-label*='Stop']",
    "button[aria-label*='停止']",
  ],
  assistant: [
    "[data-message-author-role='assistant']",
    "article[data-testid^='conversation-turn'] [data-message-author-role='assistant']",
  ],
  user: [
    "[data-message-author-role='user']",
    "article[data-testid^='conversation-turn'] [data-message-author-role='user']",
  ],
  modelButton: [
    "button[data-testid*='model-switcher']",
    "button[data-testid*='model-selector']",
    "button[aria-label*='model']",
    "button[aria-label*='模型']",
  ],
  tools: [
    "button[data-testid='composer-plus-btn']",
    "button[aria-label*='Tools']",
    "button[aria-label*='tools']",
    "button[aria-label*='工具']",
    "button[aria-label*='Add']",
    "button[aria-label*='add']",
    "button[aria-label*='更多']",
  ],
  terminalAction: [
    "button[data-testid='copy-turn-action-button']",
    "button[data-testid*='regenerate']",
    "button[data-testid*='share']",
    "button[aria-label*='Copy' i]",
    "button[aria-label*='复制']",
    "button[aria-label*='Regenerate' i]",
    "button[aria-label*='重新生成']",
    "button[aria-label*='Try again' i]",
    "button[aria-label*='Retry' i]",
    "button[aria-label*='重试']",
    "button[aria-label*='Share' i]",
    "button[aria-label*='分享']",
  ],
  pageError: [
    "[data-testid*='error']",
    "[role='alert']",
    "button[aria-label*='Continue generating' i]",
    "button[aria-label*='继续生成']",
  ],
};
const MODEL_LABEL_PATTERN = /^(?:instant|thinking(?:\s+effort)?|pro|自动|快速|思考(?:强度)?)$/i;

let activeJobId = null;
let verifiedNonPersonalizedDocumentToken = null;
let resolvedThinkingDepth = null;
let modeSelectionDiagnostics = null;
let cancelled = false;
let depthDiscovery = null;
let depthCatalog = [];
let depthCatalogAt = 0;
let accountQuota = {
  status: "unavailable",
  source: "chatgpt-usage",
  fetchedAt: null,
  windows: [],
  errorCode: null,
};
let accountQuotaAt = 0;
let accountQuotaDiscovery = null;
const TERMINAL_REPORT_GRACE_MS = 5_000;
const SELECTOR_DIAGNOSTIC_GRACE_MS = 5_000;
const TERMINAL_RESULT_CONFIRM_MS = 15_000;
const TERMINAL_COMPOSER_CONFIRM_MS = 30_000;
const ACCOUNT_QUOTA_TTL_MS = 5 * 60_000;

function safeQuotaWindow(kind, value) {
  if (!value || typeof value !== "object") return null;
  const used = Number(value.used_percent);
  const durationSeconds = Number(value.limit_window_seconds);
  const resetAtSeconds = Number(value.reset_at);
  const resetAfterSeconds = Number(value.reset_after_seconds);
  const usedPercent = Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null;
  const resetsAt = Number.isFinite(resetAtSeconds)
    ? new Date(resetAtSeconds * 1_000).toISOString()
    : Number.isFinite(resetAfterSeconds)
      ? new Date(Date.now() + resetAfterSeconds * 1_000).toISOString()
      : null;
  return {
    kind,
    usedPercent,
    remainingPercent: usedPercent == null ? null : Math.max(0, 100 - usedPercent),
    windowDurationMinutes:
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.round(durationSeconds / 60)
        : null,
    resetsAt,
  };
}

async function discoverAccountQuota() {
  if (Date.now() - accountQuotaAt < ACCOUNT_QUOTA_TTL_MS) return accountQuota;
  if (accountQuotaDiscovery) return accountQuotaDiscovery;
  accountQuotaDiscovery = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const sessionResponse = await fetch("/api/auth/session", {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!sessionResponse.ok) throw new Error("session_unavailable");
      const session = await sessionResponse.json();
      const accessToken = typeof session?.accessToken === "string" ? session.accessToken : null;
      const upstreamAccountId =
        typeof session?.account?.id === "string" ? session.account.id : null;
      if (!accessToken || !upstreamAccountId) throw new Error("session_incomplete");
      const usageResponse = await fetch("/backend-api/wham/usage", {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "chatgpt-account-id": upstreamAccountId,
          "openai-beta": "codex-1",
          "oai-language": "zh-CN",
          originator: "Codex Desktop",
        },
      });
      if (!usageResponse.ok) throw new Error(`usage_http_${usageResponse.status}`);
      const usage = await usageResponse.json();
      const windows = [
        safeQuotaWindow("primary", usage?.rate_limit?.primary_window),
        safeQuotaWindow("secondary", usage?.rate_limit?.secondary_window),
      ].filter(Boolean);
      accountQuota = {
        status: "fresh",
        source: "chatgpt-usage",
        fetchedAt: new Date().toISOString(),
        windows,
        errorCode: null,
      };
    } catch (error) {
      accountQuota = {
        ...accountQuota,
        status: accountQuota.windows.length ? "stale" : "unavailable",
        errorCode: String(error?.message ?? "quota_unavailable").slice(0, 64),
      };
    } finally {
      clearTimeout(timer);
      accountQuotaAt = Date.now();
      accountQuotaDiscovery = null;
    }
    return accountQuota;
  })();
  return accountQuotaDiscovery;
}
const TERMINAL_BLANK_CONFIRM_MS = 15_000;

async function sendRuntimeMessage(message, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("chatgpt_delivery_uncertain")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function first(selectors, root = document) {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function all(selectors, root = document) {
  const found = [];
  for (const selector of selectors) found.push(...root.querySelectorAll(selector));
  return [...new Set(found)];
}

function pageText() {
  return document.body?.innerText ?? "";
}

function failureState() {
  const text = pageText().toLowerCase();
  if (/verify you are human|checking your browser|cloudflare|验证您是真人/.test(text)) {
    return "chatgpt_verification_required";
  }
  if (
    /usage limit|rate limit|too many requests|requests too quickly|temporarily limited|try again later|达到.*限制|使用上限/.test(
      text,
    )
  ) {
    return "chatgpt_rate_limited";
  }
  // ChatGPT can leave the composer mounted behind an expired-session modal.
  // A covered editor is not proof that the account is usable.
  if (
    /your session has expired|session (?:has )?expired|please log in again|会话.*过期|登录.*过期/.test(
      text,
    )
  ) {
    return "chatgpt_login_required";
  }
  if (!first(SELECTORS.composer) && /log in|sign up|登录|注册/.test(text)) {
    return "chatgpt_login_required";
  }
  return null;
}

function authenticated() {
  return Boolean(first(SELECTORS.composer)) && !failureState();
}

function waitForMutation(timeoutMs = 750) {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve();
    }, timeoutMs);
  });
}

async function waitForElement(selectors, deadline) {
  while (Date.now() < deadline) {
    const element = first(selectors);
    if (element) return element;
    const failure = failureState();
    if (failure) throw new Error(failure);
    await waitForMutation(500);
  }
  throw new Error("chatgpt_ui_changed");
}

function visibleText(element) {
  return (element?.innerText ?? element?.textContent ?? "").trim();
}

function userMessageText(element) {
  if (!element) return "";
  // ChatGPT can append controls such as "Show more" inside a long user turn.
  // Read the message body when it is identifiable instead of including the
  // controls in the exact ownership comparison.
  const bodies = [...(element.querySelectorAll?.("[class~='whitespace-pre-wrap']") ?? [])].filter(
    (node) => !node.closest?.("button, [role='button']"),
  );
  const bodyRoots = bodies.filter(
    (node) => !bodies.some((candidate) => candidate !== node && candidate.contains?.(node)),
  );
  const bodyText = bodyRoots
    .map((node) => visibleText(node))
    .filter(Boolean)
    .join("\n");
  return bodyText || visibleText(element);
}

function userMessageDomText(element, expectedMarkup = null) {
  // A collapsed turn can omit body text from innerText while retaining the
  // exact received text in DOM text nodes. Never strip content or accept a
  // prefix: the alternate extraction must still match the entire objective.
  if (!element) return "";
  const codeSpans =
    expectedMarkup === null
      ? []
      : [...expectedMarkup.matchAll(/(?<!`)(`+)([\s\S]*?)\1(?!`)/g)].map((match) => ({
          delimiter: match[1],
          body: normalizedText(match[2]),
          leadingSpace: /^\s/.test(match[2]),
          trailingSpace: /\s$/.test(match[2]),
        }));
  let codeCursor = 0;
  const read = (node) => {
    if (node.nodeType === 3) return node.nodeValue ?? "";
    if (node.nodeType === 11) return [...node.childNodes].map(read).join("");
    if (node.nodeType !== 1) return "";
    if (
      ["BUTTON", "SVG", "SCRIPT", "STYLE"].includes(node.tagName) ||
      node.getAttribute?.("role") === "button"
    )
      return "";
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "PRE") {
      const code = node.querySelector?.("code");
      if (code) return read(code) + "\n";
    }
    const text = [...(node.childNodes ?? [])].map(read).join("");
    if (expectedMarkup !== null && node.tagName === "CODE") {
      // Restore only actual DOM code markup, using a delimiter whose enclosed
      // text matches exactly. Never remove ticks from arbitrary plain text or
      // substitute expected content for observed content.
      const body = normalizedText(text);
      const index = codeSpans.findIndex((span, i) => i >= codeCursor && span.body === body);
      if (index >= 0) {
        codeCursor = index + 1;
        const span = codeSpans[index];
        // Renderers trim code-span boundary whitespace. Restore only that
        // formatting boundary after matching the entire observed code body;
        // no source character is substituted for an observed body character.
        return (
          span.delimiter +
          (span.leadingSpace ? " " : "") +
          text +
          (span.trailingSpace ? " " : "") +
          span.delimiter
        );
      }
    }
    return [
      "P",
      "DIV",
      "PRE",
      "LI",
      "SECTION",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "UL",
      "OL",
      "TABLE",
      "TR",
      "TD",
      "TH",
      "BLOCKQUOTE",
    ].includes(node.tagName)
      ? text + "\n"
      : text;
  };
  return read(element).trim();
}

function userMessageRenderedMatches(element, objective) {
  // Parse markup in a detached inert template. No resource is fetched or source
  // script executed. Only a full, exact rendered-text match is accepted.
  if (typeof marked === "undefined" || typeof document === "undefined") return false;
  try {
    const targets = (root) =>
      [...(root?.querySelectorAll?.("a[href], img[src]") ?? [])]
        .filter((node) => !node.closest?.("button, [role='button']"))
        .map((node) => [
          node.tagName,
          node.getAttribute("href") ?? node.getAttribute("src"),
          node.getAttribute("alt") ?? "",
        ]);
    const observedTargets = JSON.stringify(targets(element));
    const observed = [
      userMessageDomText(element),
      userMessageText(element),
      visibleText(element),
    ].map(normalizedText);
    // User bubbles can use inline Markdown while assistant turns use block
    // Markdown. Both comparisons still require every rendered character and URL.
    return [marked.parse, marked.parseInline].some((parse) => {
      const template = document.createElement("template");
      template.innerHTML = parse(objective, { gfm: true, async: false });
      const expected = normalizedText(userMessageDomText(template.content));
      return (
        expected &&
        JSON.stringify(targets(template.content)) === observedTargets &&
        observed.includes(expected)
      );
    });
  } catch {
    return false;
  }
}

function userMessageComparison(element, objective) {
  const expected = normalizedText(objective ?? "");
  const visible = normalizedText(userMessageText(element));
  const dom = normalizedText(userMessageDomText(element));
  const markup = normalizedText(userMessageDomText(element, objective ?? ""));
  let markupIndex = 0;
  while (
    markupIndex < Math.min(expected.length, markup.length) &&
    expected[markupIndex] === markup[markupIndex]
  )
    markupIndex++;
  const markupDifference = {
    index: markupIndex,
    expected: [...expected.slice(Math.max(0, markupIndex - 8), markupIndex + 16)].map((c) =>
      c.codePointAt(0),
    ),
    observed: [...markup.slice(Math.max(0, markupIndex - 8), markupIndex + 16)].map((c) =>
      c.codePointAt(0),
    ),
  };
  let renderedTextLength = null;
  let renderedDifference = null;
  if (typeof marked !== "undefined" && typeof document !== "undefined") {
    try {
      const template = document.createElement("template");
      template.innerHTML = marked.parse(objective ?? "", { gfm: true, async: false });
      const rendered = normalizedText(userMessageDomText(template.content));
      renderedTextLength = rendered.length;
      let index = 0;
      while (index < Math.min(rendered.length, dom.length) && rendered[index] === dom[index])
        index++;
      renderedDifference = {
        index,
        expected: [...rendered.slice(index, index + 12)].map((c) => c.codePointAt(0)),
        observed: [...dom.slice(index, index + 12)].map((c) => c.codePointAt(0)),
      };
    } catch {
      /* Diagnostic only; ownership still requires a complete match. */
    }
  }
  let prefix = 0;
  while (prefix < Math.min(expected.length, visible.length) && expected[prefix] === visible[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(expected.length, visible.length) - prefix &&
    expected[expected.length - suffix - 1] === visible[visible.length - suffix - 1]
  )
    suffix++;
  return {
    domTextLength: dom.length,
    domMatches: dom === expected,
    markupTextLength: markup.length,
    markupMatches: markup === expected,
    markupDifference,
    renderedMatches: userMessageRenderedMatches(element, objective ?? ""),
    renderedTextLength,
    renderedDifference,
    visibleMatches: visible === expected,
    commonPrefixLength: prefix,
    commonSuffixLength: suffix,
    expectedMiddleLength: expected.length - prefix - suffix,
    visibleMiddleLength: visible.length - prefix - suffix,
  };
}

function userMessageMatchesObjective(element, objective) {
  const expected = normalizedText(objective);
  if (normalizedText(userMessageText(element)) === expected) return true;
  const full = normalizedText(visibleText(element));
  if (full === expected) return true;
  if (normalizedText(userMessageDomText(element)) === expected) return true;
  if (normalizedText(userMessageDomText(element, objective)) === expected) return true;
  if (userMessageRenderedMatches(element, objective)) return true;
  if (!full.startsWith(`${expected} `)) return false;
  const suffix = full.slice(expected.length).trim();
  return [...(element?.querySelectorAll?.("button, [role='button']") ?? [])].some(
    (control) => normalizedText(visibleText(control)) === suffix,
  );
}

async function nativeClick(element, jobId, action) {
  const rectangle = element.getBoundingClientRect();
  const browserChromeHeight = Math.max(0, window.outerHeight - window.innerHeight);
  const browserChromeWidth = Math.max(0, window.outerWidth - window.innerWidth);
  const x = Math.round(
    window.screenX + browserChromeWidth / 2 + rectangle.left + rectangle.width / 2,
  );
  const y = Math.round(window.screenY + browserChromeHeight + rectangle.top + rectangle.height / 2);
  const result = await sendRuntimeMessage({
    type: "aialra.native-click",
    jobId,
    action,
    x,
    y,
  });
  if (!result?.ok) throw new Error("chatgpt_delivery_uncertain");
}

function nativePoint(element) {
  const rectangle = element.getBoundingClientRect();
  const browserChromeHeight = Math.max(0, window.outerHeight - window.innerHeight);
  const browserChromeWidth = Math.max(0, window.outerWidth - window.innerWidth);
  return {
    x: Math.round(window.screenX + browserChromeWidth / 2 + rectangle.left + rectangle.width / 2),
    y: Math.round(window.screenY + browserChromeHeight + rectangle.top + rectangle.height / 2),
  };
}

function rectangleDiagnostics(element) {
  if (!element) return null;
  const rectangle = element.getBoundingClientRect();
  return {
    left: rectangle.left,
    top: rectangle.top,
    width: rectangle.width,
    height: rectangle.height,
  };
}

function windowMetrics() {
  const browserChromeHeight = Math.max(0, window.outerHeight - window.innerHeight);
  const browserChromeWidth = Math.max(0, window.outerWidth - window.innerWidth);
  return {
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    browserChromeWidth,
    browserChromeHeight,
    devicePixelRatio: window.devicePixelRatio,
  };
}

function canonicalEditorText(value) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/\n$/, "");
}

function composerPlainText(composer) {
  if (!composer) return "";
  const paragraphs = [...(composer.children ?? [])];
  if (!paragraphs.length || paragraphs.some((node) => node.tagName !== "P"))
    return composer.innerText ?? composer.textContent ?? "";
  const inlineText = (node) => {
    if (node.nodeType === 3) return node.nodeValue ?? "";
    if (node.nodeType !== 1) return "";
    if (node.tagName === "BR")
      return node.classList?.contains("ProseMirror-trailingBreak") ? "" : "\n";
    return [...node.childNodes].map(inlineText).join("");
  };
  // ProseMirror represents pasted lines as paragraphs. innerText adds visual
  // paragraph spacing; joining logical paragraphs preserves the caller's text.
  return paragraphs.map(inlineText).join("\n");
}

async function waitForStableComposer(deadline, stabilityMs = 1_500) {
  const stabilityDeadline = Math.min(deadline, Date.now() + 10_000);
  let candidate = null;
  let signature = "";
  let stableSince = 0;
  let stableReads = 0;
  while (Date.now() < stabilityDeadline) {
    const current = first(SELECTORS.composer);
    const rectangle = current?.getBoundingClientRect();
    const currentSignature = rectangle
      ? [rectangle.left, rectangle.top, rectangle.width, rectangle.height]
          .map((value) => Math.round(value))
          .join(":")
      : "";
    if (
      current &&
      rectangle &&
      rectangle.width > 0 &&
      rectangle.height > 0 &&
      current === candidate &&
      currentSignature === signature
    ) {
      stableReads += 1;
      if (stableReads >= 4 && Date.now() - stableSince >= stabilityMs) return current;
    } else {
      candidate = current;
      signature = currentSignature;
      stableSince = Date.now();
      stableReads = current && rectangle?.width > 0 && rectangle.height > 0 ? 1 : 0;
    }
    await waitForMutation(250);
  }
  throw new Error("chatgpt_page_not_ready");
}

async function nativeSetComposerText(composer, text, jobId, deadline, attempt = 1) {
  const point = nativePoint(composer);
  const accepted = await sendRuntimeMessage({
    type: "aialra.native-input",
    jobId,
    action: attempt === 1 ? "paste_prompt" : "paste_prompt_retry",
    x: point.x,
    y: point.y,
    text,
  });
  if (!accepted?.ok) throw new Error("chatgpt_delivery_uncertain");
  const pasteAllowance = Math.max(
    30_000,
    Math.ceil(Array.from(text).length / 3_000) * 1_800 + 10_000,
  );
  const inputDeadline = Math.min(deadline, Date.now() + pasteAllowance);
  let stableReads = 0;
  let stableSince = 0;
  while (Date.now() < inputDeadline) {
    const currentComposer = first(SELECTORS.composer);
    if (
      currentComposer &&
      canonicalEditorText(composerPlainText(currentComposer)) === canonicalEditorText(text)
    ) {
      stableReads += 1;
      stableSince ||= Date.now();
      if (stableReads >= 4 && Date.now() - stableSince >= 750) {
        const cleared = await sendRuntimeMessage({
          type: "aialra.native-input",
          jobId,
          action: "clear_clipboard",
        });
        if (!cleared?.ok) throw new Error("chatgpt_delivery_uncertain");
        await new Promise((resolve) => setTimeout(resolve, 250));
        return;
      }
    } else {
      stableReads = 0;
      stableSince = 0;
    }
    await waitForMutation(250);
  }
  throw new Error("chatgpt_delivery_uncertain");
}

function canRetryEmptyNativeInput(beforeUserCount, invocation) {
  const currentComposer = first(SELECTORS.composer);
  return Boolean(
    userMessages().length === beforeUserCount &&
    !first(SELECTORS.stop) &&
    currentComposer &&
    canonicalEditorText(composerPlainText(currentComposer)) === "" &&
    boundInvocationDocument(invocation.documentToken, invocation.temporaryChat),
  );
}

async function reportProgress(jobId, phase, diagnostics = null) {
  const result = await sendRuntimeMessage({
    type: "aialra.progress",
    jobId,
    phase,
    diagnostics,
  });
  if (!result?.ok) throw new Error("chatgpt_delivery_uncertain");
}

function modelControlForComposer() {
  const composer = first(SELECTORS.composer);
  const root = composer ? composerControlRoot(composer) : null;
  const explicit = root ? firstVisible(SELECTORS.modelButton, root) : null;
  if (explicit) return explicit;
  const scoped = root
    ? visibleEnabledButtons(root).find((element) => {
        const label = visibleText(element).split("\n")[0]?.trim() ?? "";
        return MODEL_LABEL_PATTERN.test(label);
      })
    : null;
  // Global label substring searches can mistake a sidebar conversation title
  // for a model control. Outside the composer only trust dedicated test IDs.
  return scoped ?? firstVisible(SELECTORS.modelButton.slice(0, 2));
}

let thinkingDepthDiscoveryDiagnostics = null;
const thinkingDepthMenuOwnership = new WeakMap();

async function ensureChatSurface(deadline, jobId = null) {
  if (thinkingDepthControl()) return;
  if (currentSurface() !== "work" || !controlDiagnostics().freshConversation) {
    throw new Error("chatgpt_ui_changed");
  }
  const tabs = [...document.querySelectorAll("button, [role='tab']")].filter(
    (element) =>
      isDepthControlVisible(element) &&
      !depthControlDisabled(element) &&
      visibleText(element).trim().toLowerCase() === "chat",
  );
  if (tabs.length !== 1) throw new Error("chatgpt_ui_changed");
  if (jobId) await nativeClick(tabs[0], jobId, "chat_surface");
  else tabs[0].click();
  const end = Math.min(deadline, Date.now() + 3_000);
  while (Date.now() < end) {
    if (currentSurface() === "chat" && thinkingDepthControl()) return;
    await waitForMutation(100);
  }
  throw new Error("chatgpt_ui_changed");
}

async function waitForStableThinkingDepthSurface(deadline) {
  const end = Math.min(deadline, Date.now() + 20_000);
  let stableSince = 0;
  let stableReads = 0;
  while (Date.now() < end) {
    // Temporary Chat can omit Chat/Work tabs entirely. Its composer-scoped
    // depth control is still valid; an explicitly selected Work tab is not.
    if (currentSurface() !== "work" && thinkingDepthControl()) {
      stableSince ||= Date.now();
      stableReads += 1;
      if (stableReads >= 3 && Date.now() - stableSince >= 500) return;
    } else {
      stableSince = 0;
      stableReads = 0;
    }
    await waitForMutation(100);
  }
  throw new Error("chatgpt_page_not_ready");
}

async function waitForRequestedThinkingDepthSurface(invocation, deadline) {
  // Auto has no depth to select. A Temporary Chat without a depth control can
  // still answer it; explicit depths must continue to verify before input.
  if (invocation.mode === "chat" && invocation.thinkingDepth) {
    await waitForStableThinkingDepthSurface(deadline);
  }
}

function thinkingDepthControl() {
  const composer = first(SELECTORS.composer);
  const root = composer ? composerControlRoot(composer) : null;
  if (!root) return null;
  return (
    [...root.querySelectorAll("button, [role='combobox']")].find((element) => {
      if (!isDepthControlVisible(element) || depthControlDisabled(element)) return false;
      const label = `${element.getAttribute("aria-label") ?? ""} ${visibleText(element)}`
        .replace(/\s+/g, " ")
        .trim();
      return (
        /thinking (?:time|effort|depth)|reasoning (?:effort|depth)|思考(?:时间|强度|深度)/i.test(
          label,
        ) ||
        /^(?:instant|medium|high|extra high|light|standard|extended|heavy|\d+(?:\.\d+)? pro|轻量|标准|扩展|深度|轻度|加强)$/i.test(
          label,
        ) ||
        /thinking.*(?:effort|time)|reasoning-effort/.test(element.getAttribute("data-testid") ?? "")
      );
    }) ?? null
  );
}

function isDepthControlVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
}

function depthControlDisabled(element) {
  return (
    element.disabled === true ||
    element.getAttribute("aria-disabled") === "true" ||
    element.hasAttribute("data-disabled")
  );
}

function thinkingDepthOptions(menu) {
  if (!menu) return [];
  return [
    ...menu.querySelectorAll(
      "[role='menuitemradio'], [role='option'], [role='radio'], [role='menuitem']",
    ),
  ]
    .filter((element) => isDepthControlVisible(element) && !depthControlDisabled(element))
    .map((element) => ({
      element,
      label: visibleText(element).split("\n")[0].trim(),
      selected:
        element.getAttribute("aria-checked") === "true" ||
        element.getAttribute("aria-selected") === "true" ||
        element.getAttribute("data-state") === "checked",
    }))
    .filter(
      ({ label }) => label.length > 0 && label.length <= 64 && !/[\r\n@]|https?:|\//i.test(label),
    )
    .filter(
      (entry, index, entries) => entries.findIndex((item) => item.label === entry.label) === index,
    );
}

async function openThinkingDepthMenu(control, click, deadline) {
  const visibleMenus = () =>
    [
      ...document.querySelectorAll(
        "[role='menu'], [role='listbox'], [role='radiogroup'], [role='dialog']",
      ),
    ].filter(isDepthControlVisible);
  const previous = new Set(visibleMenus());
  // Non-modal dialogs and radio groups can be permanent page controls. Only
  // an owned or modal one should prevent discovery of a newly opened menu.
  const ownedId = control.getAttribute("aria-controls");
  if (
    control.getAttribute("aria-expanded") === "true" ||
    [...previous].some(
      (popup) =>
        !["dialog", "radiogroup"].includes(popup.getAttribute("role")) ||
        popup.getAttribute("aria-modal") === "true" ||
        (ownedId && popup.id === ownedId),
    )
  )
    return null;
  await click(control);
  const keyboardFallbackAt = Date.now() + 500;
  let keyboardFallbackUsed = false;
  const end = Math.min(deadline, Date.now() + 1_500);
  while (Date.now() < end) {
    const ownedId = control.getAttribute("aria-controls");
    const owned = ownedId ? document.getElementById(ownedId) : null;
    if (owned && isDepthControlVisible(owned)) {
      thinkingDepthMenuOwnership.set(
        owned,
        visibleMenus().filter((menu) => !previous.has(menu)),
      );
      return owned;
    }
    const opened = visibleMenus().filter((menu) => !previous.has(menu));
    if (opened.length === 1) {
      thinkingDepthMenuOwnership.set(opened[0], opened);
      return opened[0];
    }
    // Some menu triggers respond to pointer-down or Enter, not HTMLElement.click().
    // Only activate the known composer control when nothing opened; never toggle
    // an expanded control or a menu the user already owns.
    if (
      !keyboardFallbackUsed &&
      Date.now() >= keyboardFallbackAt &&
      opened.length === 0 &&
      control.getAttribute("aria-expanded") !== "true"
    ) {
      keyboardFallbackUsed = true;
      control.focus();
      for (const type of ["keydown", "keyup"]) {
        control.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    }
    await waitForMutation(100);
  }
  control.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
  );
  if (control.getAttribute("aria-expanded") === "true") control.click();
  return null;
}

async function closeThinkingDepthMenu(control, menu) {
  if (!menu) return;
  const owned = thinkingDepthMenuOwnership.get(menu) ?? [menu];
  for (let level = 0; level < 3; level += 1) {
    const visible = owned.filter(isDepthControlVisible);
    if (!visible.length) return;
    visible
      .at(-1)
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (owned.some(isDepthControlVisible) && control.getAttribute("aria-expanded") === "true")
    control.click();
}

// Newer ChatGPT pages expose the effort choices as an accessible slider, not
// radio options. Read its actual labels; neither indices nor labels are models.
function thinkingDepthSlider(menu) {
  if (!menu) return null;
  const sliders = [...menu.querySelectorAll("[role='slider']")].filter(
    (element) => isDepthControlVisible(element) && !depthControlDisabled(element),
  );
  if (sliders.length !== 1) return null;
  const element = sliders[0];
  const minimum = Number(element.getAttribute("aria-valuemin"));
  const maximum = Number(element.getAttribute("aria-valuemax"));
  const value = Number(element.getAttribute("aria-valuenow"));
  if (
    ["aria-valuemin", "aria-valuemax", "aria-valuenow"].some(
      (attribute) => element.getAttribute(attribute) === null,
    ) ||
    ![minimum, maximum, value].every(Number.isSafeInteger) ||
    maximum <= minimum ||
    maximum - minimum > 31 ||
    value < minimum ||
    value > maximum
  )
    return null;
  return { element, minimum, maximum, value };
}

function thinkingDepthSliderLabel(menu, slider, control = thinkingDepthControl()) {
  const accessible = slider.element.getAttribute("aria-valuetext")?.trim();
  const depthOptions = thinkingDepthOptions(menu).filter(
    ({ label }) => !/^(?:latest|gpt[-\s]|chatgpt\b)/i.test(label),
  );
  const controlLabel = visibleText(control).trim();
  const buttons = [...menu.querySelectorAll("button")].filter(
    (element) => isDepthControlVisible(element) && !depthControlDisabled(element),
  );
  const label =
    accessible ||
    (depthOptions.length === 1
      ? visibleText(depthOptions[0].element).replace(/\s+/g, " ").trim()
      : "") ||
    (!/thinking (?:time|effort|depth)|reasoning (?:effort|depth)/i.test(controlLabel)
      ? controlLabel
      : "") ||
    (buttons.length === 1 ? visibleText(buttons[0]).trim() : "");
  return label && label.length <= 64 && !/[\r\n@]|https?:|\//i.test(label) ? label : null;
}

async function moveThinkingDepthSlider(menu, target, deadline) {
  for (let step = 0; step < 32 && Date.now() < deadline; step += 1) {
    const slider = thinkingDepthSlider(menu);
    if (!slider || target < slider.minimum || target > slider.maximum) return false;
    if (slider.value === target) return true;
    const key = target < slider.value ? "ArrowLeft" : "ArrowRight";
    slider.element.focus();
    slider.element.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true }));
    slider.element.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true }));
    // The page can acknowledge a key press after the slider animation settles.
    const end = Math.min(deadline, Date.now() + 1_000);
    while (Date.now() < end && thinkingDepthSlider(menu)?.value === slider.value)
      await waitForMutation(25);
    const current = thinkingDepthSlider(menu);
    if (!current || current.value === slider.value || Math.abs(current.value - slider.value) !== 1)
      return false;
  }
  return thinkingDepthSlider(menu)?.value === target;
}

async function readThinkingDepthChoices(menu, deadline) {
  // The popover shell can become visible before its animated slider mounts.
  // Read after layout settles, not the transient model submenu alone.
  if (menu) await new Promise((resolve) => setTimeout(resolve, 250));
  const initial = thinkingDepthSlider(menu);
  if (!initial) {
    if (menu && [...menu.querySelectorAll("[role='slider']")].some(isDepthControlVisible))
      return [];
    const options = thinkingDepthOptions(menu);
    // A model submenu may contain the current depth but is not a depth catalog.
    if (options.some(({ label }) => /^(?:latest|gpt[-\s]|chatgpt\b)/i.test(label))) return [];
    return options;
  }
  const control = thinkingDepthControl();
  const choices = [];
  let restored = false;
  try {
    for (let value = initial.minimum; value <= initial.maximum; value += 1) {
      const before = thinkingDepthSlider(menu);
      const previousLabel = before ? thinkingDepthSliderLabel(menu, before, control) : null;
      if (!(await moveThinkingDepthSlider(menu, value, deadline))) return [];
      const labelDeadline = Math.min(deadline, Date.now() + 500);
      let label = null;
      while (Date.now() < labelDeadline) {
        await waitForMutation(50);
        const current = thinkingDepthSlider(menu);
        label = current ? thinkingDepthSliderLabel(menu, current, control) : null;
        if (
          label &&
          (value === before?.value || !previousLabel || label !== previousLabel) &&
          !choices.some((entry) => entry.label === label)
        )
          break;
      }
      if (
        !label ||
        (value !== before?.value && label === previousLabel) ||
        choices.some((entry) => entry.label === label)
      )
        return [];
      choices.push({ label, selected: value === initial.value, sliderValue: value });
    }
  } finally {
    // Discovery must leave the user's original selection intact, including when
    // reading a later position fails. Restoration has its own bounded budget.
    if (thinkingDepthDiscoveryDiagnostics?.phase === "reading_choices")
      thinkingDepthDiscoveryDiagnostics.phase = "restoring_selection";
    restored = await moveThinkingDepthSlider(menu, initial.value, Date.now() + 5_000);
    if (!restored) throw new Error("chatgpt_thinking_depth_unverified");
  }
  return choices;
}

async function selectRequestedThinkingDepthSlider(menu, control, requested, deadline) {
  const initial = thinkingDepthSlider(menu);
  if (!initial) throw new Error("chatgpt_thinking_depth_unverified");
  // Selecting a task's depth only needs evidence for that depth. Catalog
  // discovery reads every position and can fail on an unrelated blank label.
  const values = [
    initial.value,
    ...Array.from(
      { length: initial.maximum - initial.minimum + 1 },
      (_, index) => initial.minimum + index,
    ).filter((value) => value !== initial.value),
  ];
  try {
    for (const value of values) {
      if (Date.now() >= deadline) throw new Error("chatgpt_thinking_depth_unverified");
      const before = thinkingDepthSlider(menu);
      const previousLabel = before ? thinkingDepthSliderLabel(menu, before, control) : null;
      thinkingDepthDiscoveryDiagnostics.phase = "moving_selection";
      thinkingDepthDiscoveryDiagnostics.sliderValue = value;
      if (!(await moveThinkingDepthSlider(menu, value, deadline)))
        throw new Error("chatgpt_thinking_depth_unverified");
      thinkingDepthDiscoveryDiagnostics.phase = "verifying_selection";
      const labelDeadline = Math.min(deadline, Date.now() + 800);
      while (Date.now() < labelDeadline) {
        await waitForMutation(50);
        const current = thinkingDepthSlider(menu);
        const label = current ? thinkingDepthSliderLabel(menu, current, control) : null;
        if (
          current?.value === value &&
          label === requested &&
          (value === before?.value || label !== previousLabel)
        ) {
          // A changed aria-valuenow can precede the rendered label. Check that
          // the requested label remains attached to this position before send.
          await waitForMutation(100);
          const confirmed = thinkingDepthSlider(menu);
          if (
            confirmed?.value === value &&
            thinkingDepthSliderLabel(menu, confirmed, control) === requested
          ) {
            thinkingDepthDiscoveryDiagnostics.phase = "selection_verified";
            return requested;
          }
        }
      }
    }
    throw new Error("chatgpt_thinking_depth_unavailable");
  } catch (error) {
    if (!(await moveThinkingDepthSlider(menu, initial.value, Date.now() + 5_000)))
      throw new Error("chatgpt_thinking_depth_unverified");
    throw error;
  }
}

async function clickThinkingDepthControl(control) {
  control.click();
  await waitForMutation(50);
  if (
    control.getAttribute("aria-expanded") === "true" ||
    [
      ...document.querySelectorAll(
        "[role='menu'], [role='listbox'], [role='radiogroup'], [role='dialog']",
      ),
    ].some(isDepthControlVisible)
  )
    return;
  const rectangle = control.getBoundingClientRect();
  const point = {
    clientX: (rectangle.left ?? 0) + rectangle.width / 2,
    clientY: (rectangle.top ?? 0) + rectangle.height / 2,
    button: 0,
    bubbles: true,
    cancelable: true,
  };
  // Fall back only if click did not open anything. Combining both activations
  // can open the nested model menu after React replaces the original trigger.
  control.dispatchEvent(
    new PointerEvent("pointerdown", {
      ...point,
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    }),
  );
  control.dispatchEvent(new MouseEvent("mousedown", { ...point, buttons: 1 }));
  control.dispatchEvent(
    new PointerEvent("pointerup", {
      ...point,
      buttons: 0,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    }),
  );
  control.dispatchEvent(new MouseEvent("mouseup", { ...point, buttons: 0 }));
}

async function discoverThinkingDepths() {
  thinkingDepthDiscoveryDiagnostics = { phase: "preflight" };
  if (activeJobId || !authenticated() || userMessages().length || first(SELECTORS.stop)) return [];
  if (!thinkingDepthControl() && currentSurface() === "work") {
    try {
      await ensureChatSurface(Date.now() + 3_000);
    } catch {
      thinkingDepthDiscoveryDiagnostics = { phase: "control_missing" };
      return [];
    }
  }
  const control = thinkingDepthControl();
  thinkingDepthDiscoveryDiagnostics = { phase: control ? "control_found" : "control_missing" };
  if (!control) return [];
  const ownedId = control.getAttribute("aria-controls");
  const ownedMenu = ownedId ? document.getElementById(ownedId) : null;
  if (ownedMenu?.id === ownedId && isDepthControlVisible(ownedMenu)) {
    // A user-owned menu may already be open. Read only its static radio choices;
    // never move a slider or close a menu that discovery did not open.
    const options = thinkingDepthOptions(ownedMenu);
    const valid =
      options.length > 0 &&
      options.length <= 32 &&
      !options.some(({ label }) => /^(?:latest|gpt[-\s]|chatgpt\b)/i.test(label));
    thinkingDepthDiscoveryDiagnostics = {
      phase: valid ? "discovered" : "choices_unreadable",
      hadOpenMenu: true,
      menuFound: true,
      controlExpanded: control.getAttribute("aria-expanded") === "true",
      optionCount: options.length,
      visiblePopupRoles: [ownedMenu.getAttribute("role") ?? "unknown"],
    };
    if (!valid) return [];
    return [
      {
        id: "chatgpt-web.auto",
        displayName: "ChatGPT 网页自动选择",
        available: true,
        webThinkingDepths: options.map(({ label }) => label),
        defaultWebThinkingDepth: options.find(({ selected }) => selected)?.label ?? null,
      },
    ];
  }
  let menu = null;
  try {
    const hadOpenMenu =
      control.getAttribute("aria-expanded") === "true" ||
      [
        ...document.querySelectorAll(
          "[role='menu'], [role='listbox'], [role='radiogroup'], [role='dialog']",
        ),
      ].some(isDepthControlVisible);
    menu = await openThinkingDepthMenu(control, clickThinkingDepthControl, Date.now() + 1_500);
    const slider = thinkingDepthSlider(menu);
    thinkingDepthDiscoveryDiagnostics = {
      phase: menu ? "menu_opened" : "menu_missing",
      hadOpenMenu,
      menuFound: Boolean(menu),
      controlExpanded: control.getAttribute("aria-expanded") === "true",
      visiblePopupCount: [
        ...document.querySelectorAll(
          "[role='menu'], [role='listbox'], [role='radiogroup'], [role='dialog'], [data-radix-popper-content-wrapper]",
        ),
      ].filter(isDepthControlVisible).length,
      visiblePopupRoles: [
        ...document.querySelectorAll(
          "[role='menu'], [role='listbox'], [role='radiogroup'], [role='dialog']",
        ),
      ]
        .filter(isDepthControlVisible)
        .map((popup) => popup.getAttribute("role") ?? "unknown"),
      visibleSliderCount: [
        ...document.querySelectorAll("[role='slider'], input[type='range']"),
      ].filter(isDepthControlVisible).length,
      optionCount: thinkingDepthOptions(menu).length,
      sliderCount: menu ? menu.querySelectorAll("[role='slider']").length : 0,
      buttonCount: menu ? menu.querySelectorAll("button").length : 0,
      sliderMinimum: slider?.minimum ?? null,
      sliderMaximum: slider?.maximum ?? null,
      sliderValue: slider?.value ?? null,
      sliderHasLabel: Boolean(slider && thinkingDepthSliderLabel(menu, slider)),
    };
    const options = await readThinkingDepthChoices(menu, Date.now() + 5_000);
    thinkingDepthDiscoveryDiagnostics.phase = options.length
      ? "discovered"
      : menu
        ? "choices_unreadable"
        : "menu_missing";
    if (!options.length || options.length > 32) return [];
    return [
      {
        id: "chatgpt-web.auto",
        displayName: "ChatGPT 网页自动选择",
        available: true,
        webThinkingDepths: options.map((option) => option.label),
        defaultWebThinkingDepth: options.find((option) => option.selected)?.label ?? null,
      },
    ];
  } finally {
    await closeThinkingDepthMenu(control, menu);
  }
}

async function configureThinkingDepth(invocation, deadline) {
  const requested = invocation.thinkingDepth;
  let control = thinkingDepthControl();
  if (!control && requested) {
    thinkingDepthDiscoveryDiagnostics = { phase: "control_missing" };
    // The control may briefly disappear while Temporary Chat hydrates.
    // This is still before input and submission, so wait for a stable page.
    await waitForStableThinkingDepthSurface(Math.min(deadline, Date.now() + 5_000)).catch(() => {});
    control = thinkingDepthControl();
  }
  if (!control) {
    if (requested) throw new Error("chatgpt_thinking_depth_unavailable");
    return null;
  }
  const visibleLabel = visibleText(control).replace(/\s+/g, " ").trim();
  if (
    !requested &&
    visibleLabel &&
    visibleLabel.length <= 64 &&
    !/[\r\n@]|https?:|\//i.test(visibleLabel) &&
    !/thinking (?:time|effort|depth)|reasoning (?:effort|depth)|思考(?:时间|强度|深度)/i.test(
      visibleLabel,
    )
  ) {
    return visibleLabel;
  }
  let menu = null;
  try {
    // Use the same verified opener as discovery. Moving the real pointer onto
    // the popover can activate its nested model menu while reading the slider.
    thinkingDepthDiscoveryDiagnostics = { phase: "configuring_menu" };
    menu = await openThinkingDepthMenu(control, clickThinkingDepthControl, deadline);
    thinkingDepthDiscoveryDiagnostics.phase = "reading_choices";
    let slider = thinkingDepthSlider(menu);
    if (menu && !slider) {
      // The popover can open before its animated slider becomes visible.
      await new Promise((resolve) => setTimeout(resolve, 250));
      slider = thinkingDepthSlider(menu);
    }
    if (slider) {
      if (requested) {
        const selected = await selectRequestedThinkingDepthSlider(
          menu,
          control,
          requested,
          Math.min(deadline, Date.now() + 7_000),
        );
        thinkingDepthDiscoveryDiagnostics.phase = "selection_verified";
        return selected;
      }
      const selected = thinkingDepthSliderLabel(menu, slider, control);
      if (!selected) throw new Error("chatgpt_thinking_depth_unavailable");
      return selected;
    }
    const option = (
      await readThinkingDepthChoices(menu, Math.min(deadline, Date.now() + 5_000))
    ).find((entry) => (requested ? entry.label === requested : entry.selected));
    if (!option) throw new Error("chatgpt_thinking_depth_unavailable");
    if (!requested) return option.label;
    if (option.sliderValue !== undefined) {
      thinkingDepthDiscoveryDiagnostics.phase = "moving_selection";
      const moved = await moveThinkingDepthSlider(menu, option.sliderValue, deadline);
      // React can update aria-valuenow before the visible label. Require both
      // to agree, but allow the label to render within the existing deadline.
      const end = Math.min(deadline, Date.now() + 1_500);
      thinkingDepthDiscoveryDiagnostics.phase = "verifying_selection";
      while (moved && Date.now() < end) {
        const slider = thinkingDepthSlider(menu);
        if (
          slider?.value === option.sliderValue &&
          thinkingDepthSliderLabel(menu, slider) === requested
        ) {
          thinkingDepthDiscoveryDiagnostics.phase = "selection_verified";
          return requested;
        }
        await waitForMutation(50);
      }
      throw new Error("chatgpt_thinking_depth_unverified");
    }
    if (option.selected) return requested;
    await nativeClick(option.element, invocation.jobId, "thinking_depth_option");
    const end = Math.min(deadline, Date.now() + 1_500);
    while (Date.now() < end) {
      const selected = thinkingDepthOptions(menu).find(
        (entry) => entry.label === requested && entry.selected,
      );
      const current = control.isConnected === false ? thinkingDepthControl() : control;
      const currentLabel = visibleText(current).split("\n")[0].trim();
      if (selected || currentLabel === requested) return requested;
      await waitForMutation(100);
    }
    throw new Error("chatgpt_thinking_depth_unverified");
  } finally {
    await closeThinkingDepthMenu(control, menu);
  }
}

function buttonByText(pattern, excluded = null) {
  const isExcluded = (element) => {
    const exclusions = excluded instanceof Set ? [...excluded] : [excluded];
    return exclusions.some(
      (candidate) =>
        candidate &&
        (element === candidate || candidate.contains(element) || element.contains(candidate)),
    );
  };
  const semanticControl = [
    ...document.querySelectorAll("button, [role='menuitem'], [role='option']"),
  ]
    .filter((element) => {
      const rectangle = element.getBoundingClientRect();
      return (
        !isExcluded(element) &&
        rectangle.width > 0 &&
        rectangle.height > 0 &&
        pattern.test(`${element.getAttribute("aria-label") ?? ""} ${visibleText(element)}`.trim())
      );
    })
    .sort(
      (left, right) =>
        `${left.getAttribute("aria-label") ?? ""} ${visibleText(left)}`.length -
        `${right.getAttribute("aria-label") ?? ""} ${visibleText(right)}`.length,
    )[0];
  if (semanticControl) return semanticControl;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const textMatches = [];
  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const text = textNode.nodeValue?.trim() ?? "";
    const parent = textNode.parentElement;
    if (!text || !parent || !pattern.test(text)) continue;
    if (isExcluded(parent)) continue;
    let candidate = null;
    for (
      let current = parent;
      current && current !== document.body;
      current = current.parentElement
    ) {
      const rectangle = current.getBoundingClientRect();
      if (rectangle.height > 96) break;
      if (rectangle.width > 0 && rectangle.height > 0 && pattern.test(visibleText(current))) {
        candidate = current;
        break;
      }
    }
    if (!candidate || isExcluded(candidate)) continue;
    const rectangle = candidate.getBoundingClientRect();
    if (rectangle.width > 0 && rectangle.height > 0) textMatches.push(candidate);
  }
  return textMatches.sort((left, right) => {
    const widthDelta = left.getBoundingClientRect().width - right.getBoundingClientRect().width;
    return widthDelta || visibleText(left).length - visibleText(right).length;
  })[0];
}

async function waitForButtonByText(pattern, deadline, excluded = null) {
  const controlDeadline = Math.min(deadline, Date.now() + 5_000);
  while (Date.now() < controlDeadline) {
    const button = buttonByText(pattern, excluded);
    if (button) return button;
    await waitForMutation(250);
  }
  return null;
}

async function waitForStableButtonByText(pattern, deadline, excluded = null) {
  const stabilityDeadline = Math.min(deadline, Date.now() + 8_000);
  let candidate = null;
  let signature = "";
  let stableSince = 0;
  let stableReads = 0;
  while (Date.now() < stabilityDeadline) {
    const current = buttonByText(pattern, excluded);
    const rectangle = current?.getBoundingClientRect();
    const currentSignature = rectangle
      ? [rectangle.left, rectangle.top, rectangle.width, rectangle.height]
          .map((value) => Math.round(value))
          .join(":")
      : "";
    if (
      current &&
      rectangle &&
      rectangle.width > 0 &&
      rectangle.height > 0 &&
      current === candidate &&
      currentSignature === signature
    ) {
      stableReads += 1;
      if (stableReads >= 3 && Date.now() - stableSince >= 750) return current;
    } else {
      candidate = current;
      signature = currentSignature;
      stableSince = Date.now();
      stableReads = current && rectangle?.width > 0 && rectangle.height > 0 ? 1 : 0;
    }
    await waitForMutation(250);
  }
  return null;
}

async function configureMode(mode, jobId, deadline) {
  if (mode === "chat") return;
  const searchPattern = /web search|search the web|(^|\s)search(\s|$)|网页搜索|联网搜索/i;
  const pattern = mode === "search" ? searchPattern : /deep research|深度研究/i;
  // Remember every matching control before opening the menu. The real mode row
  // appears only after the tools popover opens and must not be confused with
  // any of the existing sidebar, navigation, or conversation Search controls.
  const preexistingModeControls = new Set(
    [...document.querySelectorAll("button, [role='menuitem'], [role='option']")].filter(
      (element) => {
        const rectangle = element.getBoundingClientRect();
        return (
          rectangle.width > 0 &&
          rectangle.height > 0 &&
          pattern.test(`${element.getAttribute("aria-label") ?? ""} ${visibleText(element)}`.trim())
        );
      },
    ),
  );
  const tools = first(SELECTORS.tools) ?? buttonByText(/tools|工具|add.*more|更多/i);
  modeSelectionDiagnostics = {
    mode,
    phase: "preflight",
    preexistingMatchCount: preexistingModeControls.size,
    visiblePopupCount: 0,
    matchingControlCount: 0,
    newMatchingControlCount: 0,
    popupLabels: [],
    toolsControl: describeControl(tools),
    selectedOption: null,
  };
  if (!tools) throw new Error("chatgpt_ui_changed");
  await nativeClick(tools, jobId, "tools_menu");
  modeSelectionDiagnostics.phase = "tools_clicked";
  // The tools popover animates from the composer. Reading a row's rectangle on
  // the first mutation produces a stale Y coordinate and can click the row
  // above it after the animation settles.
  await new Promise((resolve) => setTimeout(resolve, 650));
  const visiblePopups = [
    ...document.querySelectorAll(
      "[role='menu'], [role='listbox'], [role='radiogroup'], [role='dialog']",
    ),
  ].filter(isDepthControlVisible);
  const matchingControls = [
    ...document.querySelectorAll("button, [role='menuitem'], [role='option']"),
  ].filter((element) => {
    const rectangle = element.getBoundingClientRect();
    return (
      rectangle.width > 0 &&
      rectangle.height > 0 &&
      pattern.test(`${element.getAttribute("aria-label") ?? ""} ${visibleText(element)}`.trim())
    );
  });
  const popupLabels = visiblePopups
    .flatMap((popup) => [
      ...popup.querySelectorAll(
        "button, [role='menuitem'], [role='menuitemradio'], [role='option']",
      ),
    ])
    .map((element) => visibleText(element).replace(/\s+/g, " ").trim())
    .filter(
      (label, index, labels) =>
        label.length > 0 &&
        label.length <= 64 &&
        !/[@\r\n]|https?:|\//i.test(label) &&
        labels.indexOf(label) === index,
    )
    .slice(0, 16);
  modeSelectionDiagnostics.visiblePopupCount = visiblePopups.length;
  modeSelectionDiagnostics.matchingControlCount = matchingControls.length;
  modeSelectionDiagnostics.newMatchingControlCount = matchingControls.filter(
    (element) => !preexistingModeControls.has(element),
  ).length;
  modeSelectionDiagnostics.popupLabels = popupLabels;
  // Match the concrete tools-menu row, not the shorter global Search control in
  // ChatGPT's sidebar. The sidebar control previously won the text-length sort
  // and opened conversation search instead of enabling web search.
  const option = await waitForStableButtonByText(
    pattern,
    deadline,
    preexistingModeControls.size > 0 ? preexistingModeControls : tools,
  );
  if (!option) {
    modeSelectionDiagnostics.phase = "option_missing";
    // A recognizable open tools menu can legitimately omit a capability in
    // Temporary Chat. Do not classify that as a broken account or leave it.
    if (
      mode === "deep_research" &&
      buttonByText(
        searchPattern,
        preexistingModeControls.size > 0 ? preexistingModeControls : tools,
      )
    ) {
      throw new Error("chatgpt_mode_unavailable");
    }
    throw new Error("chatgpt_ui_changed");
  }
  modeSelectionDiagnostics.phase = "option_selected";
  modeSelectionDiagnostics.selectedOption = describeControl(option);
  await nativeClick(option, jobId, "mode_option");
  const activationPattern = mode === "search" ? searchPattern : /deep research|深度研究/i;
  const activationDeadline = Math.min(deadline, Date.now() + 8_000);
  while (Date.now() < activationDeadline) {
    const activeComposer = first(SELECTORS.composer);
    const activeRoot = activeComposer ? composerControlRoot(activeComposer) : null;
    if (activeRoot && activationPattern.test(visibleText(activeRoot))) {
      modeSelectionDiagnostics.phase = "activated";
      return;
    }
    await waitForMutation(250);
  }
  modeSelectionDiagnostics.phase = "activation_missing";
  throw new Error("chatgpt_ui_changed");
}

function isTemporaryChatControlLabel(label) {
  return /^(?:(?:(?:turn|switch) (?:on|off)|enable|disable|open|close|start|exit|leave|use) )?temporary(?: chat)?(?: (?:mode|toggle|button|on|off|enabled|disabled|active|inactive))?$|^(?:开启|关闭|启用|停用|进入|退出)?临时聊天(?:模式|开关|按钮|已开启|已关闭|开启中)?$/i.test(
    normalizedText(label).replace(/[-_]+/g, " "),
  );
}

function temporaryChatControlLabels(element) {
  return [
    element.getAttribute("aria-label") ?? "",
    element.getAttribute("title") ?? "",
    element.getAttribute("data-testid") ?? "",
    element.getAttribute("data-tooltip") ?? "",
    visibleText(element),
  ].filter(Boolean);
}

function temporaryChatControls() {
  return [
    ...document.querySelectorAll(
      "button, [role='button'], [role='switch'], [data-testid*='temporary' i]",
    ),
  ].filter((element) => {
    // ChatGPT collapses the top-right pill to an icon at narrower widths. Its
    // accessible name is then just "Temporary"; some builds expose the stable
    // identity only through title, tooltip, or data-testid.
    return temporaryChatControlLabels(element).some(isTemporaryChatControlLabel);
  });
}

function temporaryChatIntroControl() {
  return [...document.querySelectorAll("button, [role='button']")].find((element) => {
    const rectangle = element.getBoundingClientRect();
    if (
      rectangle.width <= 0 ||
      rectangle.height <= 0 ||
      getComputedStyle(element).visibility === "hidden"
    ) {
      return false;
    }
    const textLabel = normalizedText(visibleText(element));
    const ariaLabel = normalizedText(element.getAttribute("aria-label") ?? "");
    if (!/^(?:continue|继续)$/i.test(textLabel) && !/^(?:continue|继续)$/i.test(ariaLabel)) {
      return false;
    }
    let ancestor = element;
    for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
      if (/temporary chat|临时聊天/i.test(visibleText(ancestor))) return true;
    }
    return temporaryChatUrlEnabled();
  });
}

function temporaryChatUrlEnabled() {
  try {
    const url = new URL(window.location.href);
    return (
      url.origin === "https://chatgpt.com" &&
      url.pathname === "/" &&
      url.searchParams.get("temporary-chat") === "true"
    );
  } catch {
    return false;
  }
}

function temporaryChatSemanticMarker() {
  return [
    ...document.querySelectorAll(
      "main h1, main h2, main [role='heading'], [contenteditable='true'], textarea",
    ),
  ].some((element) => {
    const marker = normalizedText(
      [
        visibleText(element),
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("data-placeholder") ?? "",
        element.getAttribute("placeholder") ?? "",
      ].join(" "),
    );
    return /(^|\s)(temporary chat|临时聊天)(\s|$)/i.test(marker);
  });
}

function temporaryChatEnabled() {
  const explicitControlState = temporaryChatControls().some((element) => {
    const labels = temporaryChatControlLabels(element).join(" ");
    const explicitState =
      element.getAttribute("aria-pressed") === "true" ||
      element.getAttribute("aria-checked") === "true" ||
      ["on", "checked", "active"].includes(element.getAttribute("data-state") ?? "");
    return (
      explicitState ||
      /(?:turn off|disable|exit|leave|close) temporary(?: chat)?|temporary(?: chat)?.*(?:on|enabled|active)|(?:关闭|停用|退出)临时聊天|临时聊天.*(?:已开启|开启中)/i.test(
        labels,
      )
    );
  });
  return explicitControlState || temporaryChatUrlEnabled();
}

function temporaryChatPersonalized() {
  const personalizationControls = [
    ...document.querySelectorAll(
      "input[type='checkbox'], [role='checkbox'], [role='switch'], button[aria-pressed]",
    ),
  ].filter((element) => {
    const label = normalizedText(
      `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${visibleText(element)}`,
    );
    return /personaliz|个性化/i.test(label);
  });
  for (const element of personalizationControls) {
    if (element instanceof HTMLInputElement && element.type === "checkbox") {
      return element.checked;
    }
    const state =
      element.getAttribute("aria-checked") ??
      element.getAttribute("aria-pressed") ??
      element.getAttribute("data-state");
    if (["true", "checked", "on", "active"].includes(state ?? "")) return true;
    if (["false", "unchecked", "off", "inactive"].includes(state ?? "")) return false;
  }
  if (!temporaryChatEnabled()) return null;
  if (verifiedNonPersonalizedDocumentToken === DOCUMENT_TOKEN) return false;
  const labels = [...document.querySelectorAll("button, [role='button'], [role='menuitem']")]
    .map((element) =>
      normalizedText(
        `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${visibleText(element)}`,
      ),
    )
    .filter(Boolean);
  if (
    labels.some((label) =>
      /turn on personalization|enable personalization|unpersonalized|non-personalized|not personalized|without personalization|开启个性化|不使用个性化|非个性化|不启用个性化/i.test(
        label,
      ),
    )
  ) {
    return false;
  }
  if (
    labels.some((label) =>
      /turn off personalization|personalization enabled|个性化已开启|关闭个性化/i.test(label),
    )
  ) {
    return true;
  }
  return null;
}

async function configureNonPersonalizedTemporaryChat(jobId, deadline) {
  let acceptedDefaultNonPersonalized = temporaryChatUrlEnabled();
  const intro = temporaryChatIntroControl();
  if (intro) {
    if (temporaryChatPersonalized() === true) throw new Error("chatgpt_ui_changed");
    await nativeClick(intro, jobId, "temporary_chat_intro");
    acceptedDefaultNonPersonalized = true;
    const introDeadline = Math.min(deadline, Date.now() + 7_500);
    while (Date.now() < introDeadline) {
      if (!temporaryChatIntroControl()) break;
      await waitForMutation(250);
    }
    if (temporaryChatIntroControl()) throw new Error("chatgpt_ui_changed");
  }
  const currentPersonalization = temporaryChatPersonalized();
  if (
    temporaryChatEnabled() &&
    currentPersonalization !== true &&
    (currentPersonalization === false || acceptedDefaultNonPersonalized)
  ) {
    verifiedNonPersonalizedDocumentToken = DOCUMENT_TOKEN;
    return;
  }
  const control = temporaryChatControls().find((candidate) => {
    const rectangle = candidate.getBoundingClientRect();
    return rectangle.width > 0 && rectangle.height > 0;
  });
  if (!control) throw new Error("chatgpt_ui_changed");
  if (!temporaryChatEnabled()) {
    await nativeClick(control, jobId, "temporary_chat");
    acceptedDefaultNonPersonalized = true;
  }

  const selectionDeadline = Math.min(deadline, Date.now() + 7_500);
  while (Date.now() < selectionDeadline) {
    const nonPersonalized = buttonByText(
      /continue without personalization|without personalization|non-personalized|not personalized|不使用个性化|非个性化|不启用个性化/i,
    );
    if (nonPersonalized) {
      await nativeClick(nonPersonalized, jobId, "temporary_chat_non_personalized");
      acceptedDefaultNonPersonalized = true;
    }
    const continueControl = temporaryChatIntroControl();
    if (continueControl && temporaryChatPersonalized() !== true) {
      await nativeClick(continueControl, jobId, "temporary_chat_intro");
      acceptedDefaultNonPersonalized = true;
    }
    const personalization = temporaryChatPersonalized();
    if (
      temporaryChatEnabled() &&
      personalization !== true &&
      (personalization === false || acceptedDefaultNonPersonalized)
    ) {
      verifiedNonPersonalizedDocumentToken = DOCUMENT_TOKEN;
      return;
    }
    await waitForMutation(250);
  }
  throw new Error("chatgpt_ui_changed");
}

function composerControlRoot(composer) {
  return (
    composer.closest("form") ??
    composer.closest("[data-testid*='composer']") ??
    composer.parentElement?.parentElement ??
    composer.parentElement
  );
}

function visibleEnabledButtons(root = document) {
  return [...root.querySelectorAll("button, [role='button']")].filter((element) => {
    const rectangle = element.getBoundingClientRect();
    return (
      !element.disabled &&
      element.getAttribute("aria-disabled") !== "true" &&
      rectangle.width > 0 &&
      rectangle.height > 0
    );
  });
}

function firstVisible(selectors, root = document) {
  for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) {
      const rectangle = element.getBoundingClientRect();
      if (
        !element.disabled &&
        element.getAttribute("aria-disabled") !== "true" &&
        rectangle.width > 0 &&
        rectangle.height > 0
      ) {
        return element;
      }
    }
  }
  return null;
}

function sendControlFor(composer) {
  const root = composerControlRoot(composer);
  const local = root?.isConnected ? firstVisible(SELECTORS.send, root) : null;
  const exact = local ?? firstVisible(SELECTORS.send);
  if (exact) return exact;
  const rightmost = visibleEnabledButtons(root?.isConnected ? root : document)
    .sort((left, right) => right.getBoundingClientRect().right - left.getBoundingClientRect().right)
    .at(0);
  const label = `${rightmost?.getAttribute("aria-label") ?? ""}`;
  if (/voice|dictation|microphone|语音|听写|麦克风/i.test(label)) return null;
  return rightmost ?? null;
}

async function waitForSendControl(composer, deadline) {
  const controlDeadline = Math.min(deadline, Date.now() + 5_000);
  let previousCenter = "";
  let stableReads = 0;
  while (Date.now() < controlDeadline) {
    const send = sendControlFor(composer);
    if (send) {
      const rectangle = send.getBoundingClientRect();
      const center = `${Math.round(rectangle.left + rectangle.width / 2)}:${Math.round(
        rectangle.top + rectangle.height / 2,
      )}`;
      if (center === previousCenter) {
        stableReads += 1;
      } else {
        previousCenter = center;
        stableReads = 1;
      }
      if (stableReads >= 2) return send;
    }
    await waitForMutation(250);
  }
  throw new Error("chatgpt_ui_changed");
}

async function submitComposer(send, jobId) {
  await nativeClick(send, jobId, "send_prompt");
}

function safeControlLabel(label) {
  if (!label) return null;
  const categories = [
    ["send", /^(?:send\b|发送)/i],
    ["voice", /^(?:(?:start|use|open)\s+)?(?:voice\b|语音)/i],
    ["dictation", /^(?:(?:start|stop)\s+)?(?:dictation\b|听写)/i],
    ["microphone", /^(?:microphone\b|麦克风)/i],
    ["add", /^(?:add\b|添加)/i],
    ["attach", /^(?:attach\b|附件)/i],
    ["model", /^(?:(?:select|choose|change|switch)\s+)?(?:model\b|模型)/i],
    ["tools", /^(?:tools?\b|工具)/i],
    ["temporary", /^(?:temporary\b|临时)/i],
    ["copy", /^(?:copy\b|复制)/i],
    ["regenerate", /^(?:regenerate\b|重新生成)/i],
    ["share", /^(?:share\b|分享)/i],
    ["retry", /^(?:try again\b|retry\b|重试)/i],
  ];
  return categories.find(([, pattern]) => pattern.test(label.trim()))?.[0] ?? null;
}

function describeControl(element) {
  if (!element) return null;
  const rawTestId = element.getAttribute("data-testid");
  const rawAriaLabel = element.getAttribute("aria-label");
  return {
    tag: element.tagName.toLowerCase(),
    testId: rawTestId && /^[a-z0-9_-]+$/i.test(rawTestId) ? rawTestId : null,
    ariaLabel: safeControlLabel(rawAriaLabel),
    role: element.getAttribute("role"),
    buttonType: element.getAttribute("type"),
    disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
  };
}

function pageKind() {
  if (/^\/(?:$|new(?:\/|$))/.test(location.pathname)) return "home";
  if (/^\/(?:c|share)\//.test(location.pathname)) return "conversation";
  return "other";
}

function taskPageIsSupported() {
  const kind = pageKind();
  return kind === "home" || kind === "conversation";
}

function boundTemporaryDocument(documentToken) {
  const personalized = temporaryChatPersonalized();
  return (
    documentToken === DOCUMENT_TOKEN &&
    taskPageIsSupported() &&
    temporaryChatEnabled() &&
    // The personalization choice is verified as false before the one allowed
    // submission. ChatGPT temporarily hides that control while generating, so
    // null means "not currently observable" rather than "personalized". An
    // explicit true still invalidates ownership immediately.
    personalized !== true
  );
}

function boundInvocationDocument(documentToken, temporaryChat) {
  if (temporaryChat) return boundTemporaryDocument(documentToken);
  return (
    documentToken === DOCUMENT_TOKEN && taskPageIsSupported() && temporaryChatEnabled() === false
  );
}

function currentSurface() {
  const controls = [...document.querySelectorAll("button, [role='tab']")].filter((element) => {
    const rectangle = element.getBoundingClientRect();
    return (
      rectangle.width > 0 && rectangle.height > 0 && /^(chat|work)$/i.test(visibleText(element))
    );
  });
  const selected = controls.find(
    (element) =>
      element.getAttribute("aria-pressed") === "true" ||
      element.getAttribute("aria-selected") === "true" ||
      element.getAttribute("aria-current") === "page" ||
      ["on", "checked", "active"].includes(element.getAttribute("data-state") ?? ""),
  );
  const label = visibleText(selected).toLowerCase();
  return label === "chat" || label === "work" ? label : "unknown";
}

function assistantTurnElements() {
  return all(SELECTORS.assistant);
}

function assistantTurnContainer(element) {
  return (
    element?.closest("[data-testid^='conversation-turn']") ?? element?.closest("article") ?? element
  );
}

function terminalActionsFor(element) {
  const root = assistantTurnContainer(element);
  const controls = root ? all(SELECTORS.terminalAction, root) : [];
  for (const control of all(SELECTORS.terminalAction)) {
    if (visibleErrorKind(control) === "retry") controls.push(control);
  }
  return [...new Set(controls)].filter((control) => {
    const rectangle = control.getBoundingClientRect();
    const style = getComputedStyle(control);
    return (
      rectangle.width > 0 &&
      rectangle.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  });
}

function visibleErrorKind(element) {
  const value = `${element.getAttribute("data-testid") ?? ""} ${element.getAttribute("aria-label") ?? ""} ${visibleText(element)}`;
  if (/continue generating|继续生成/i.test(value)) return "continue_generating";
  if (/regenerate|try again|retry|重新生成|重试/i.test(value)) return "retry";
  if (/something went wrong|went wrong|network error|error generating|出错|错误/i.test(value)) {
    return "generation_error";
  }
  return "other";
}

function hasTerminalCopyAction(element) {
  return terminalActionsFor(element).some((control) => {
    const value = `${control.getAttribute("data-testid") ?? ""} ${control.getAttribute("aria-label") ?? ""}`;
    return /copy-turn-action-button|copy response|复制/i.test(value);
  });
}

function hasTerminalComposerState() {
  const composer = firstVisible(SELECTORS.composer);
  if (!composer || first(SELECTORS.stop)) return false;
  const root = composerControlRoot(composer);
  return Boolean(sendControlFor(composer) || visibleEnabledButtons(root ?? document).length);
}

function visibleErrorKinds() {
  return visiblePageErrors().map(visibleErrorKind).slice(0, 16);
}

function visibleErrorDiagnostics() {
  return visiblePageErrors()
    .slice(0, 16)
    .map((element) => ({
      kind: visibleErrorKind(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      testId: /^[a-z0-9_-]+$/i.test(element.getAttribute("data-testid") ?? "")
        ? element.getAttribute("data-testid")
        : null,
      textLength: visibleText(element).length,
      childElementCount: element.childElementCount,
    }));
}

function visiblePageErrors() {
  return all(SELECTORS.pageError).filter((element) => {
    const rectangle = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rectangle.width > 0 && rectangle.height > 0 && style.visibility !== "hidden";
  });
}

function assistantTextChannels(element) {
  if (!element) {
    return {
      textContent: "",
      innerText: "",
      accessibleName: "",
      extracted: "",
      containerInnerText: "",
      containerMarkdown: "",
    };
  }
  const textContent = (element.textContent ?? "").trim();
  const innerText = (element.innerText ?? "").trim();
  const accessibleName = (element.getAttribute("aria-label") ?? "").trim();
  const root = assistantTurnContainer(element);
  const markdown = [
    ...(root ?? element).querySelectorAll(".markdown, [data-message-content], [class*='prose']"),
  ]
    .map((candidate) => (candidate.innerText ?? candidate.textContent ?? "").trim())
    .filter(Boolean)
    .join("\n");
  return {
    textContent,
    innerText,
    accessibleName,
    extracted: markdown || innerText || textContent || accessibleName,
    containerInnerText: (root?.innerText ?? root?.textContent ?? "").trim(),
    containerMarkdown: markdown,
  };
}

function assistantElementDiagnostics(element) {
  if (!element) return null;
  const rectangle = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const { textContent, innerText, accessibleName, containerInnerText, containerMarkdown } =
    assistantTextChannels(element);
  return {
    textContentLength: textContent.length,
    innerTextLength: innerText.length,
    accessibleNameLength: accessibleName.length,
    containerInnerTextLength: containerInnerText.length,
    containerMarkdownLength: containerMarkdown.length,
    childElementCount: element.childElementCount,
    containerChildElementCount: assistantTurnContainer(element)?.childElementCount ?? 0,
    directChildTags: [...element.children].slice(0, 16).map((child) => child.tagName.toLowerCase()),
    width: Math.max(0, Math.round(rectangle.width)),
    height: Math.max(0, Math.round(rectangle.height)),
    visible:
      rectangle.width > 0 &&
      rectangle.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0,
    opacity: style.opacity || "1",
  };
}

function diagnosticPersonalization() {
  const observed = temporaryChatPersonalized();
  if (observed !== null) return observed;
  return activeJobId &&
    verifiedNonPersonalizedDocumentToken === DOCUMENT_TOKEN &&
    temporaryChatEnabled()
    ? false
    : null;
}

function controlDiagnostics(expectedObjective = null) {
  const composer = first(SELECTORS.composer);
  const modelControl = modelControlForComposer();
  const rawModelControlText = visibleText(modelControl).split("\n")[0]?.trim().slice(0, 64) ?? "";
  const modelControlText = MODEL_LABEL_PATTERN.test(rawModelControlText)
    ? rawModelControlText
    : null;
  const controlRoot = composer ? composerControlRoot(composer) : null;
  const assistantTurns = assistantTurnElements();
  const latestAssistant = assistantTurns.at(-1);
  const users = userMessages();
  const latestUserText = normalizedText(userMessageText(users.at(-1)));
  const expectedUserText = expectedObjective ? normalizedText(expectedObjective) : null;
  const sameRowControls = controlRoot
    ? visibleEnabledButtons(controlRoot).slice(-16).map(describeControl).filter(Boolean)
    : [];
  return {
    composerFound: Boolean(composer),
    composerPoint: composer ? nativePoint(composer) : null,
    composerRect: rectangleDiagnostics(composer),
    windowMetrics: windowMetrics(),
    temporaryChatControlFound: temporaryChatControls().some((element) => {
      const rectangle = element.getBoundingClientRect();
      return rectangle.width > 0 && rectangle.height > 0;
    }),
    temporaryChatEnabled: temporaryChatEnabled(),
    temporaryChatPersonalized: diagnosticPersonalization(),
    modelControlFound: Boolean(modelControl),
    modelControl: describeControl(modelControl),
    modelControlText,
    modelControlPoint: modelControl ? nativePoint(modelControl) : null,
    toolsControlFound: Boolean(
      first(SELECTORS.tools) ?? buttonByText(/tools|工具|add.*more|更多/i),
    ),
    selectedSend: composer ? describeControl(sendControlFor(composer)) : null,
    sameRowControls,
    thinkingDepthDiscovery: thinkingDepthDiscoveryDiagnostics,
    modeSelection: modeSelectionDiagnostics,
    resolvedThinkingDepth,
    pageKind: pageKind(),
    surface: currentSurface(),
    assistantTurnCount: assistantTurns.length,
    blankAssistantTurnCount: assistantTurns.filter((element) => !visibleText(element)).length,
    latestAssistantHasText: Boolean(latestAssistant && visibleText(latestAssistant)),
    generationActive: Boolean(first(SELECTORS.stop)),
    userTurnCount: users.length,
    latestUserTextLength: latestUserText.length,
    expectedUserTextLength: expectedUserText?.length ?? null,
    userMessageComparison:
      expectedObjective === null ? null : userMessageComparison(users.at(-1), expectedObjective),
    latestUserMatchesObjective:
      expectedUserText === null
        ? null
        : userMessageMatchesObjective(users.at(-1), expectedObjective),
    composerTextLength: canonicalEditorText(composerPlainText(composer)).length,
    documentToken: DOCUMENT_TOKEN,
    freshConversation:
      pageKind() === "home" &&
      users.length === 0 &&
      assistantTurns.length === 0 &&
      canonicalEditorText(composerPlainText(composer)).length === 0 &&
      !first(SELECTORS.stop),
    terminalActionCount: terminalActionsFor(latestAssistant).length,
    terminalActions: terminalActionsFor(latestAssistant).map(describeControl).filter(Boolean),
    visibleErrorCount: visiblePageErrors().length,
    visibleErrorKinds: visibleErrorKinds(),
    visibleErrors: visibleErrorDiagnostics(),
    latestAssistant: assistantElementDiagnostics(latestAssistant),
  };
}

function assistantMessages() {
  return assistantTurnElements().filter((element) => visibleText(element));
}

function userMessages() {
  return all(SELECTORS.user).filter((element) => userMessageText(element));
}

function normalizedText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function completionMarkerFor(jobId) {
  return `AIALRA_WEB_END_${jobId.replace(/-/g, "").slice(0, 16).toUpperCase()}`;
}

function objectiveWithCompletionMarker(objective, completionMarker) {
  // Append the sentinel without rewriting any paragraphs in the caller's text.
  return `${objective} 回答完成后，在最后一行原样输出 ${completionMarker}`;
}

function withoutCompletionMarker(outputText, completionMarker) {
  const markerIndex = outputText.lastIndexOf(completionMarker);
  if (markerIndex < 0) return outputText;
  return `${outputText.slice(0, markerIndex)}${outputText.slice(markerIndex + completionMarker.length)}`.trim();
}

function hasForeignCompletionMarker(outputText, completionMarker) {
  const markers = outputText.match(/AIALRA_WEB_END_[A-F0-9]{16}/g) ?? [];
  return markers.some((marker) => marker !== completionMarker);
}

function structuredCodeResult(element, completionMarker) {
  const root = assistantTurnContainer(element);
  const codes = [...(root?.querySelectorAll?.("pre code") ?? [])];
  if (codes.length !== 1 || !completionMarker || !root?.cloneNode) return null;
  const rawWithMarker = (codes[0].textContent ?? "").trim();
  if (hasForeignCompletionMarker(rawWithMarker, completionMarker)) return null;
  const raw = withoutCompletionMarker(rawWithMarker, completionMarker).trim();
  try {
    if (typeof JSON.parse(raw) !== "object" || JSON.parse(raw) === null) return null;
  } catch {
    return null;
  }
  const remaining = root.cloneNode(true);
  for (const node of remaining.querySelectorAll("pre,button,[role='button'],svg")) {
    node.replaceWith(root.ownerDocument.createTextNode(" "));
  }
  const remainder = normalizedText(
    withoutCompletionMarker(remaining.textContent ?? "", completionMarker),
  );
  // Only a language label and this job's completion marker may surround the
  // single JSON code block. Additional prose is retained by the normal path.
  if (!["", "json", "JSON"].includes(remainder)) return null;
  return raw;
}

function extractResult(element, completionMarker = null) {
  const rawOutputText =
    structuredCodeResult(element, completionMarker) ?? assistantTextChannels(element).extracted;
  const outputText = completionMarker
    ? withoutCompletionMarker(rawOutputText, completionMarker)
    : rawOutputText;
  const root = assistantTurnContainer(element);
  const sourceRoot = root ?? element;
  const linkedSources = [...sourceRoot.querySelectorAll("a[href]")].map((anchor) => anchor.href);
  const textSources = rawOutputText.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  const sources = [
    ...new Set(
      [...linkedSources, ...textSources]
        .map((source) => source.replace(/[.,;:!?，。；：！？]+$/u, ""))
        .filter(Boolean),
    ),
  ];
  return { outputText, sources };
}

async function waitForUserEcho(
  beforeCount,
  objective,
  documentToken,
  deadline,
  jobId,
  temporaryChat = true,
) {
  let matchedStableReads = 0;
  let matchedStableSince = 0;
  let lastMismatch = "";
  let mismatchStableReads = 0;
  let mismatchStableSince = 0;
  let lastDiagnosticAt = 0;
  while (Date.now() < deadline) {
    const failure = failureState();
    if (failure) throw new Error(failure);
    if (!boundInvocationDocument(documentToken, temporaryChat)) {
      throw new Error("chatgpt_delivery_uncertain");
    }
    const messages = userMessages();
    if (messages.length > beforeCount + 1) {
      throw new Error("chatgpt_delivery_uncertain");
    }
    if (messages.length === beforeCount + 1) {
      const actual = normalizedText(userMessageText(messages.at(-1)));
      if (userMessageMatchesObjective(messages.at(-1), objective)) {
        matchedStableReads += 1;
        matchedStableSince ||= Date.now();
        if (matchedStableReads >= 2 && Date.now() - matchedStableSince >= 750) return;
      } else if (actual) {
        matchedStableReads = 0;
        matchedStableSince = 0;
        if (actual === lastMismatch) {
          mismatchStableReads += 1;
        } else {
          lastMismatch = actual;
          mismatchStableReads = 1;
          mismatchStableSince = Date.now();
        }
        if (mismatchStableReads >= 3 && Date.now() - mismatchStableSince >= 1_000) {
          throw new Error("chatgpt_delivery_uncertain");
        }
      }
    }
    if (Date.now() - lastDiagnosticAt >= 5_000) {
      lastDiagnosticAt = Date.now();
      await reportProgress(jobId, "submitted", controlDiagnostics(objective));
    }
    await waitForMutation(500);
  }
  throw new Error("chatgpt_delivery_uncertain");
}

async function waitForStableResult(
  beforeCount,
  beforeUserCount,
  objective,
  completionMarker,
  documentToken,
  deadline,
  jobId,
  temporaryChat = true,
) {
  let lastText = "";
  let stableReads = 0;
  let stableSince = 0;
  let blankSince = 0;
  let terminalSince = 0;
  let assistantObserved = false;
  let lastDiagnosticAt = 0;
  while (Date.now() < deadline) {
    if (cancelled) throw new Error("cancelled");
    const failure = failureState();
    if (failure) throw new Error(failure);
    const users = userMessages();
    const latestUser = users.at(-1);
    if (
      !boundInvocationDocument(documentToken, temporaryChat) ||
      users.length !== beforeUserCount + 1 ||
      !userMessageMatchesObjective(latestUser, objective)
    ) {
      throw new Error("chatgpt_delivery_uncertain");
    }
    const allMessages = assistantTurnElements();
    const newest = allMessages.at(-1);
    if (allMessages.length > beforeCount && newest) {
      assistantObserved = true;
      if (!(latestUser.compareDocumentPosition(newest) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        throw new Error("chatgpt_delivery_uncertain");
      }
      const channels = assistantTextChannels(newest);
      const sample = channels.extracted;
      const generating = Boolean(first(SELECTORS.stop));
      if (generating) {
        terminalSince = 0;
        if (sample && sample === lastText) {
          stableReads += 1;
        } else {
          lastText = sample;
          stableReads = sample ? 1 : 0;
          stableSince = sample ? Date.now() : 0;
        }
        if (
          sample.includes(completionMarker) &&
          stableReads >= 3 &&
          Date.now() - stableSince >= 2_000
        ) {
          if (hasForeignCompletionMarker(sample, completionMarker)) {
            throw new Error("chatgpt_delivery_uncertain");
          }
          return extractResult(newest, completionMarker);
        }
        blankSince = 0;
      } else if (sample) {
        blankSince = 0;
        const hasCopyAction = hasTerminalCopyAction(newest);
        const hasComposerState = hasTerminalComposerState();
        if (hasCopyAction || hasComposerState) terminalSince ||= Date.now();
        else terminalSince = 0;
        if (sample === lastText) {
          stableReads += 1;
        } else {
          lastText = sample;
          stableReads = 1;
          stableSince = Date.now();
        }
        if (
          stableReads >= 2 &&
          ((sample.includes(completionMarker) && Date.now() - stableSince >= 1_000) ||
            (terminalSince &&
              Date.now() - Math.max(stableSince, terminalSince) >=
                (hasCopyAction ? TERMINAL_RESULT_CONFIRM_MS : TERMINAL_COMPOSER_CONFIRM_MS)))
        ) {
          if (hasForeignCompletionMarker(sample, completionMarker)) {
            throw new Error("chatgpt_delivery_uncertain");
          }
          return extractResult(newest, completionMarker);
        }
        if (terminalActionsFor(newest).some((control) => visibleErrorKind(control) === "retry")) {
          throw new Error("chatgpt_output_incomplete");
        }
      } else {
        terminalSince = 0;
        blankSince ||= Date.now();
        if (terminalActionsFor(newest).some((control) => visibleErrorKind(control) === "retry")) {
          throw new Error("chatgpt_page_generation_blank");
        }
        if (Date.now() - blankSince >= TERMINAL_BLANK_CONFIRM_MS && hasTerminalCopyAction(newest)) {
          throw new Error("chatgpt_page_generation_blank");
        }
        if (Date.now() - blankSince >= SELECTOR_DIAGNOSTIC_GRACE_MS) {
          const diagnostic = assistantElementDiagnostics(newest);
          if (
            diagnostic &&
            (diagnostic.textContentLength > 0 ||
              diagnostic.innerTextLength > 0 ||
              diagnostic.accessibleNameLength > 0 ||
              diagnostic.containerMarkdownLength > 0)
          ) {
            throw new Error(
              diagnostic.visible
                ? "chatgpt_output_selector_changed"
                : "chatgpt_page_rendering_failed",
            );
          }
        }
      }
    }
    if (Date.now() - lastDiagnosticAt >= 5_000) {
      lastDiagnosticAt = Date.now();
      await reportProgress(jobId, "generating", controlDiagnostics(objective));
    }
    await waitForMutation(750);
  }
  throw new Error(
    lastText
      ? "chatgpt_output_incomplete"
      : assistantObserved
        ? "chatgpt_page_generation_blank"
        : "chatgpt_output_incomplete_blank",
  );
}

async function invoke(invocation) {
  if (activeJobId) return { ok: false, code: "chatgpt_delivery_uncertain" };
  if (invocation.documentToken && invocation.documentToken !== DOCUMENT_TOKEN) {
    return { ok: false, code: "chatgpt_delivery_uncertain", documentToken: DOCUMENT_TOKEN };
  }
  activeJobId = invocation.jobId;
  resolvedThinkingDepth = null;
  modeSelectionDiagnostics = null;
  cancelled = false;
  const deadline = invocation.deadlineAt - TERMINAL_REPORT_GRACE_MS;
  try {
    if (depthDiscovery) await depthDiscovery;
    if (deadline <= Date.now()) throw new Error("chatgpt_page_not_ready");
    const failure = failureState();
    if (failure) throw new Error(failure);
    const completionMarker = completionMarkerFor(invocation.jobId);
    const pageObjective = objectiveWithCompletionMarker(invocation.objective, completionMarker);
    let composer = await waitForElement(SELECTORS.composer, deadline);
    if (!controlDiagnostics().freshConversation) throw new Error("chatgpt_ui_changed");
    if (invocation.mode !== "deep_research") {
      await ensureChatSurface(deadline, invocation.jobId);
      composer = await waitForElement(SELECTORS.composer, deadline);
      if (!controlDiagnostics().freshConversation) throw new Error("chatgpt_ui_changed");
    }
    await reportProgress(invocation.jobId, "configuring");
    const temporaryRequest =
      invocation.mode !== "deep_research" &&
      invocation.conversationMode === "temporary_per_request" &&
      invocation.temporaryChat === true &&
      invocation.personalized === false;
    const persistentDeepResearch =
      invocation.mode === "deep_research" &&
      invocation.conversationMode === "persistent_per_request" &&
      invocation.temporaryChat === false &&
      invocation.personalized === true &&
      invocation.persistenceAcknowledged === true;
    if (!temporaryRequest && !persistentDeepResearch) throw new Error("chatgpt_ui_changed");
    if (temporaryRequest) {
      await configureNonPersonalizedTemporaryChat(invocation.jobId, deadline);
      if (!temporaryChatEnabled() || temporaryChatPersonalized() !== false) {
        throw new Error("chatgpt_ui_changed");
      }
      verifiedNonPersonalizedDocumentToken = DOCUMENT_TOKEN;
      await reportProgress(invocation.jobId, "temporary_chat_verified");
    } else {
      if (temporaryChatEnabled()) throw new Error("chatgpt_ui_changed");
      await reportProgress(invocation.jobId, "persistent_chat_verified");
    }
    await configureMode(invocation.mode, invocation.jobId, deadline);
    await waitForRequestedThinkingDepthSurface(invocation, deadline);
    resolvedThinkingDepth = await configureThinkingDepth(invocation, deadline);
    await reportProgress(invocation.jobId, "mode_selected", controlDiagnostics());
    composer = await waitForStableComposer(deadline);
    const beforeAssistantCount = assistantTurnElements().length;
    const beforeUserCount = userMessages().length;
    // A missed native paste may be repeated only while the page proves no message was sent.
    const inputAttempts = 2;
    for (let attempt = 1; attempt <= inputAttempts; attempt += 1) {
      try {
        await nativeSetComposerText(composer, pageObjective, invocation.jobId, deadline, attempt);
        break;
      } catch (error) {
        if (attempt >= inputAttempts || !canRetryEmptyNativeInput(beforeUserCount, invocation))
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        composer = await waitForStableComposer(deadline);
      }
    }
    composer = await waitForElement(SELECTORS.composer, deadline);
    if (canonicalEditorText(composerPlainText(composer)) !== canonicalEditorText(pageObjective)) {
      throw new Error("chatgpt_delivery_uncertain");
    }
    // The visible DOM can become correct before ChatGPT's editor state has
    // consumed the native paste. Wait once, then verify the exact text again.
    await new Promise((resolve) => setTimeout(resolve, 750));
    composer = await waitForElement(SELECTORS.composer, deadline);
    if (canonicalEditorText(composerPlainText(composer)) !== canonicalEditorText(pageObjective)) {
      throw new Error("chatgpt_delivery_uncertain");
    }
    const send = await waitForSendControl(composer, deadline);
    if (send.disabled) throw new Error("chatgpt_delivery_uncertain");
    await reportProgress(invocation.jobId, "input_ready");
    await submitComposer(send, invocation.jobId);
    await reportProgress(invocation.jobId, "submitted", controlDiagnostics(pageObjective));
    await waitForUserEcho(
      beforeUserCount,
      pageObjective,
      invocation.documentToken,
      deadline,
      invocation.jobId,
      invocation.temporaryChat,
    );
    await reportProgress(invocation.jobId, "user_echo_verified", controlDiagnostics(pageObjective));
    await reportProgress(invocation.jobId, "generating", controlDiagnostics(pageObjective));
    const result = await waitForStableResult(
      beforeAssistantCount,
      beforeUserCount,
      pageObjective,
      completionMarker,
      invocation.documentToken,
      deadline,
      invocation.jobId,
      invocation.temporaryChat,
    );
    await reportProgress(invocation.jobId, "stabilizing");
    if (invocation.requireSources && result.sources.length === 0) {
      throw new Error("chatgpt_sources_missing");
    }
    return { ok: true, ...result, conversationUrl: location.href, documentToken: DOCUMENT_TOKEN };
  } catch (error) {
    const code = String(error?.message ?? error);
    return {
      ok: false,
      code: code === "cancelled" ? "chatgpt_output_incomplete" : code,
      message: "page_execution_failed",
      diagnostics: controlDiagnostics(
        objectiveWithCompletionMarker(invocation.objective, completionMarkerFor(invocation.jobId)),
      ),
      documentToken: DOCUMENT_TOKEN,
    };
  } finally {
    activeJobId = null;
    verifiedNonPersonalizedDocumentToken = null;
    resolvedThinkingDepth = null;
    modeSelectionDiagnostics = null;
    cancelled = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!primaryContentScript) return false;
  if (message.type === "aialra.probe") {
    const failureCode = failureState();
    const pageAuthenticated = authenticated();
    if (!pageAuthenticated) {
      depthCatalog = [];
      accountQuota = {
        status: "unavailable",
        source: "chatgpt-usage",
        fetchedAt: null,
        windows: [],
        errorCode: "login_required",
      };
      accountQuotaAt = Date.now();
    } else if (accountQuota.errorCode === "login_required") {
      accountQuotaAt = 0;
    }
    if (
      message.discoverModels &&
      !activeJobId &&
      !depthDiscovery &&
      Date.now() - depthCatalogAt > 60_000
    ) {
      depthDiscovery = discoverThinkingDepths()
        .then((models) => {
          depthCatalog = models;
          depthCatalogAt = Date.now();
        })
        .catch(() => {
          depthCatalog = [];
        })
        .finally(() => {
          depthDiscovery = null;
        });
    }
    const quotaDiscovery =
      message.discoverQuota && !activeJobId && pageAuthenticated
        ? discoverAccountQuota()
        : Promise.resolve(accountQuota);
    void Promise.all([Promise.resolve(depthDiscovery), quotaDiscovery]).then(() =>
      sendResponse({
        pageReady: Boolean(first(SELECTORS.composer)),
        authenticated: pageAuthenticated,
        models: depthCatalog,
        quota: accountQuota,
        diagnostics: controlDiagnostics(),
        documentToken: DOCUMENT_TOKEN,
        failureCode,
      }),
    );
    return true;
  }
  if (message.type === "aialra.invoke") {
    const invocation = message.invocation;
    sendResponse({ accepted: true, documentToken: DOCUMENT_TOKEN });
    void invoke(invocation).then((result) =>
      chrome.runtime.sendMessage({
        type: "aialra.result",
        jobId: invocation.jobId,
        result,
      }),
    );
    return false;
  }
  if (message.type === "aialra.composer-point") {
    const composer = first(SELECTORS.composer);
    sendResponse({ ok: Boolean(composer), point: composer ? nativePoint(composer) : null });
    return false;
  }
  if (message.type === "aialra.cancel" && activeJobId === message.jobId) {
    cancelled = true;
    first(SELECTORS.stop)?.click();
    sendResponse({ ok: true });
  }
  return false;
});
