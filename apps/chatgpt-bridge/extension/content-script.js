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
let cancelled = false;
const TERMINAL_REPORT_GRACE_MS = 5_000;

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

async function nativeClick(element, jobId, action) {
  const rectangle = element.getBoundingClientRect();
  const browserChromeHeight = Math.max(0, window.outerHeight - window.innerHeight);
  const browserChromeWidth = Math.max(0, window.outerWidth - window.innerWidth);
  const x = Math.round(
    window.screenX + browserChromeWidth / 2 + rectangle.left + rectangle.width / 2,
  );
  const y = Math.round(
    window.screenY +
      browserChromeHeight +
      rectangle.top +
      rectangle.height / 2 +
      (action === "mode_option" ? 60 : 0),
  );
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

function canonicalEditorText(value) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/\n$/, "");
}

async function nativeSetComposerText(composer, text, jobId, deadline) {
  const point = nativePoint(composer);
  const accepted = await sendRuntimeMessage({
    type: "aialra.native-input",
    jobId,
    action: "paste_prompt",
    x: point.x,
    y: point.y,
    text,
  });
  if (!accepted?.ok) throw new Error("chatgpt_delivery_uncertain");
  const inputDeadline = Math.min(deadline, Date.now() + 30_000);
  let stableReads = 0;
  let stableSince = 0;
  while (Date.now() < inputDeadline) {
    const currentComposer = first(SELECTORS.composer);
    if (
      currentComposer &&
      canonicalEditorText(currentComposer.innerText ?? currentComposer.textContent ?? "") ===
        canonicalEditorText(text)
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
  return scoped ?? firstVisible(SELECTORS.modelButton) ?? buttonByText(MODEL_LABEL_PATTERN);
}

function buttonByText(pattern, excluded = null) {
  const semanticControl = [
    ...document.querySelectorAll("button, [role='menuitem'], [role='option']"),
  ]
    .filter((element) => {
      const rectangle = element.getBoundingClientRect();
      return (
        element !== excluded &&
        !excluded?.contains(element) &&
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
    if (parent === excluded || excluded?.contains(parent)) continue;
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
    if (!candidate) continue;
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

async function configureMode(mode, jobId, deadline) {
  if (mode === "chat") return;
  const tools = first(SELECTORS.tools) ?? buttonByText(/tools|工具|add.*more|更多/i);
  if (!tools) throw new Error("chatgpt_ui_changed");
  await nativeClick(tools, jobId, "tools_menu");
  // The tools popover animates from the composer. Reading a row's rectangle on
  // the first mutation produces a stale Y coordinate and can click the row
  // above it after the animation settles.
  await new Promise((resolve) => setTimeout(resolve, 650));
  // Match the concrete tools-menu row, not the shorter global Search control in
  // ChatGPT's sidebar. The sidebar control previously won the text-length sort
  // and opened conversation search instead of enabling web search.
  const pattern = mode === "search" ? /web search|网页搜索|联网搜索/i : /deep research|深度研究/i;
  const option = await waitForButtonByText(pattern, deadline, tools);
  if (!option) throw new Error("chatgpt_ui_changed");
  await nativeClick(option, jobId, "mode_option");
  const activationPattern =
    mode === "search" ? /web search|网页搜索|联网搜索/i : /deep research|深度研究/i;
  const activationDeadline = Math.min(deadline, Date.now() + 5_000);
  while (Date.now() < activationDeadline) {
    const activeComposer = first(SELECTORS.composer);
    const activeRoot = activeComposer ? composerControlRoot(activeComposer) : null;
    if (activeRoot && activationPattern.test(visibleText(activeRoot))) return;
    await waitForMutation(250);
  }
  throw new Error("chatgpt_ui_changed");
}

function temporaryChatControls() {
  return [...document.querySelectorAll("button, [role='button']")].filter((element) =>
    /temporary chat|临时聊天/i.test(
      `${element.getAttribute("aria-label") ?? ""} ${visibleText(element)}`,
    ),
  );
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
    const label = `${element.getAttribute("aria-label") ?? ""} ${visibleText(element)}`;
    const explicitState =
      element.getAttribute("aria-pressed") === "true" ||
      element.getAttribute("aria-checked") === "true" ||
      ["on", "checked", "active"].includes(element.getAttribute("data-state") ?? "");
    return (
      explicitState ||
      /turn off temporary chat|temporary chat.*(?:on|enabled)|关闭临时聊天|临时聊天.*(?:已开启|开启中)/i.test(
        label,
      )
    );
  });
  return explicitControlState || (temporaryChatUrlEnabled() && temporaryChatSemanticMarker());
}

function temporaryChatPersonalized() {
  if (!temporaryChatEnabled()) return null;
  const labels = [...document.querySelectorAll("button, [role='button'], [role='menuitem']")]
    .map((element) =>
      normalizedText(
        `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${visibleText(element)}`,
      ),
    )
    .filter(Boolean);
  if (
    labels.some((label) =>
      /unpersonalized|non-personalized|not personalized|without personalization|不使用个性化|非个性化|不启用个性化/i.test(
        label,
      ),
    )
  ) {
    return false;
  }
  if (
    labels.some((label) =>
      /(^|\s)personalized(\s|$)|personalization enabled|个性化临时聊天|临时聊天.*个性化/i.test(
        label,
      ),
    )
  ) {
    return true;
  }
  return null;
}

async function configureNonPersonalizedTemporaryChat(jobId, deadline) {
  if (temporaryChatEnabled() && temporaryChatPersonalized() === false) return;
  const control = temporaryChatControls().find((candidate) => {
    const rectangle = candidate.getBoundingClientRect();
    return rectangle.width > 0 && rectangle.height > 0;
  });
  if (!control) throw new Error("chatgpt_ui_changed");
  if (!temporaryChatEnabled()) {
    await nativeClick(control, jobId, "temporary_chat");
  }

  const selectionDeadline = Math.min(deadline, Date.now() + 7_500);
  while (Date.now() < selectionDeadline) {
    const nonPersonalized = buttonByText(
      /continue without personalization|without personalization|non-personalized|not personalized|不使用个性化|非个性化|不启用个性化/i,
    );
    if (nonPersonalized) {
      await nativeClick(nonPersonalized, jobId, "temporary_chat_non_personalized");
    }
    if (temporaryChatEnabled() && temporaryChatPersonalized() === false) return;
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

function describeControl(element) {
  if (!element) return null;
  const rawTestId = element.getAttribute("data-testid");
  const rawAriaLabel = element.getAttribute("aria-label");
  return {
    tag: element.tagName.toLowerCase(),
    testId: rawTestId && /^[a-z0-9_-]+$/i.test(rawTestId) ? rawTestId : null,
    ariaLabel:
      rawAriaLabel &&
      /send|voice|dictation|microphone|add|attach|model|tool|temporary|copy|regenerate|share|try again|retry|发送|语音|听写|麦克风|添加|附件|模型|工具|临时|复制|重新生成|分享|重试/i.test(
        rawAriaLabel,
      )
        ? rawAriaLabel
        : null,
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
  return (
    documentToken === DOCUMENT_TOKEN &&
    taskPageIsSupported() &&
    temporaryChatEnabled() &&
    temporaryChatPersonalized() === false
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
    element?.closest("article[data-testid^='conversation-turn']") ??
    element?.closest("article") ??
    element
  );
}

function terminalActionsFor(element) {
  const root = assistantTurnContainer(element);
  return root
    ? all(SELECTORS.terminalAction, root).filter((control) => {
        const rectangle = control.getBoundingClientRect();
        const style = getComputedStyle(control);
        return (
          rectangle.width > 0 &&
          rectangle.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      })
    : [];
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
  const latestUserText = normalizedText(visibleText(users.at(-1)));
  const expectedUserText = expectedObjective ? normalizedText(expectedObjective) : null;
  const sameRowControls = controlRoot
    ? visibleEnabledButtons(controlRoot).slice(-16).map(describeControl).filter(Boolean)
    : [];
  return {
    composerFound: Boolean(composer),
    temporaryChatEnabled: temporaryChatEnabled(),
    temporaryChatPersonalized: temporaryChatPersonalized(),
    modelControlFound: Boolean(modelControl),
    modelControl: describeControl(modelControl),
    modelControlText,
    modelControlPoint: modelControl ? nativePoint(modelControl) : null,
    toolsControlFound: Boolean(
      first(SELECTORS.tools) ?? buttonByText(/tools|工具|add.*more|更多/i),
    ),
    selectedSend: composer ? describeControl(sendControlFor(composer)) : null,
    sameRowControls,
    pageKind: pageKind(),
    surface: currentSurface(),
    assistantTurnCount: assistantTurns.length,
    blankAssistantTurnCount: assistantTurns.filter((element) => !visibleText(element)).length,
    latestAssistantHasText: Boolean(latestAssistant && visibleText(latestAssistant)),
    generationActive: Boolean(first(SELECTORS.stop)),
    userTurnCount: users.length,
    latestUserTextLength: latestUserText.length,
    expectedUserTextLength: expectedUserText?.length ?? null,
    latestUserMatchesObjective:
      expectedUserText === null ? null : latestUserText === expectedUserText,
    composerTextLength: canonicalEditorText(composer?.innerText ?? composer?.textContent ?? "")
      .length,
    documentToken: DOCUMENT_TOKEN,
    freshConversation:
      pageKind() === "home" &&
      users.length === 0 &&
      assistantTurns.length === 0 &&
      canonicalEditorText(composer?.innerText ?? composer?.textContent ?? "").length === 0 &&
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
  return all(SELECTORS.user).filter((element) => visibleText(element));
}

function normalizedText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function completionMarkerFor(jobId) {
  return `AIALRA_WEB_END_${jobId.replace(/-/g, "").slice(0, 16).toUpperCase()}`;
}

function objectiveWithCompletionMarker(objective, completionMarker) {
  // Keep the sentinel instruction in the same editor paragraph. ChatGPT's
  // ProseMirror editor expands pasted paragraph breaks in innerText, which
  // makes an exact native-input verification fail before the one allowed send.
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

function extractResult(element, completionMarker = null) {
  const rawOutputText = assistantTextChannels(element).extracted;
  const outputText = completionMarker
    ? withoutCompletionMarker(rawOutputText, completionMarker)
    : rawOutputText;
  const root = assistantTurnContainer(element);
  const sources = [...(root ?? element).querySelectorAll("a[href]")].map((anchor) => anchor.href);
  return { outputText, sources };
}

async function waitForUserEcho(beforeCount, objective, documentToken, deadline, jobId) {
  let matchedStableReads = 0;
  let matchedStableSince = 0;
  let lastMismatch = "";
  let mismatchStableReads = 0;
  let mismatchStableSince = 0;
  let lastDiagnosticAt = 0;
  while (Date.now() < deadline) {
    const failure = failureState();
    if (failure) throw new Error(failure);
    if (!boundTemporaryDocument(documentToken)) {
      throw new Error("chatgpt_delivery_uncertain");
    }
    const messages = userMessages();
    if (messages.length > beforeCount + 1) {
      throw new Error("chatgpt_delivery_uncertain");
    }
    if (messages.length === beforeCount + 1) {
      const actual = normalizedText(visibleText(messages.at(-1)));
      if (actual === normalizedText(objective)) {
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
) {
  let lastText = "";
  let stableReads = 0;
  let stableSince = 0;
  let blankSince = 0;
  let lastDiagnosticAt = 0;
  while (Date.now() < deadline) {
    if (cancelled) throw new Error("cancelled");
    const failure = failureState();
    if (failure) throw new Error(failure);
    const users = userMessages();
    const latestUser = users.at(-1);
    const latestUserText = normalizedText(visibleText(latestUser));
    if (
      !boundTemporaryDocument(documentToken) ||
      users.length !== beforeUserCount + 1 ||
      latestUserText !== normalizedText(objective)
    ) {
      throw new Error("chatgpt_delivery_uncertain");
    }
    const allMessages = assistantTurnElements();
    const newest = allMessages.at(-1);
    if (allMessages.length > beforeCount && newest) {
      if (!(latestUser.compareDocumentPosition(newest) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        throw new Error("chatgpt_delivery_uncertain");
      }
      const channels = assistantTextChannels(newest);
      const sample = channels.extracted;
      const generating = Boolean(first(SELECTORS.stop));
      if (generating) {
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
        if (sample === lastText) {
          stableReads += 1;
        } else {
          lastText = sample;
          stableReads = 1;
          stableSince = Date.now();
        }
        if (
          sample.includes(completionMarker) &&
          stableReads >= 2 &&
          Date.now() - stableSince >= 1_000
        ) {
          if (hasForeignCompletionMarker(sample, completionMarker)) {
            throw new Error("chatgpt_delivery_uncertain");
          }
          return extractResult(newest, completionMarker);
        }
      } else {
        blankSince ||= Date.now();
        if (Date.now() - blankSince >= 15_000) {
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
          throw new Error("chatgpt_page_generation_blank");
        }
      }
    }
    if (Date.now() - lastDiagnosticAt >= 5_000) {
      lastDiagnosticAt = Date.now();
      await reportProgress(jobId, "generating", controlDiagnostics(objective));
    }
    await waitForMutation(750);
  }
  throw new Error(lastText ? "chatgpt_output_incomplete" : "chatgpt_output_incomplete_blank");
}

async function invoke(invocation) {
  if (activeJobId) return { ok: false, code: "chatgpt_delivery_uncertain" };
  if (invocation.documentToken && invocation.documentToken !== DOCUMENT_TOKEN) {
    return { ok: false, code: "chatgpt_delivery_uncertain", documentToken: DOCUMENT_TOKEN };
  }
  activeJobId = invocation.jobId;
  cancelled = false;
  const deadline = invocation.deadlineAt - TERMINAL_REPORT_GRACE_MS;
  try {
    if (deadline <= Date.now()) throw new Error("chatgpt_page_not_ready");
    const failure = failureState();
    if (failure) throw new Error(failure);
    const completionMarker = completionMarkerFor(invocation.jobId);
    const pageObjective = objectiveWithCompletionMarker(invocation.objective, completionMarker);
    let composer = await waitForElement(SELECTORS.composer, deadline);
    if (!controlDiagnostics().freshConversation) throw new Error("chatgpt_ui_changed");
    await reportProgress(invocation.jobId, "configuring");
    if (
      invocation.conversationMode !== "temporary_per_request" ||
      invocation.temporaryChat !== true ||
      invocation.personalized !== false
    ) {
      throw new Error("chatgpt_ui_changed");
    }
    await configureNonPersonalizedTemporaryChat(invocation.jobId, deadline);
    if (!temporaryChatEnabled() || temporaryChatPersonalized() !== false) {
      throw new Error("chatgpt_ui_changed");
    }
    await reportProgress(invocation.jobId, "temporary_chat_verified");
    await configureMode(invocation.mode, invocation.jobId, deadline);
    await reportProgress(invocation.jobId, "mode_selected");
    composer = await waitForElement(SELECTORS.composer, deadline);
    const beforeAssistantCount = assistantTurnElements().length;
    const beforeUserCount = userMessages().length;
    await nativeSetComposerText(composer, pageObjective, invocation.jobId, deadline);
    composer = await waitForElement(SELECTORS.composer, deadline);
    if (
      canonicalEditorText(composer.innerText ?? composer.textContent ?? "") !==
      canonicalEditorText(pageObjective)
    ) {
      throw new Error("chatgpt_delivery_uncertain");
    }
    // The visible DOM can become correct before ChatGPT's editor state has
    // consumed the native paste. Wait once, then verify the exact text again.
    await new Promise((resolve) => setTimeout(resolve, 750));
    composer = await waitForElement(SELECTORS.composer, deadline);
    if (
      canonicalEditorText(composer.innerText ?? composer.textContent ?? "") !==
      canonicalEditorText(pageObjective)
    ) {
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
    );
    await reportProgress(invocation.jobId, "stabilizing");
    if (invocation.requireSources && result.sources.length === 0) {
      throw new Error("chatgpt_output_incomplete");
    }
    return { ok: true, ...result, conversationUrl: location.href, documentToken: DOCUMENT_TOKEN };
  } catch (error) {
    const code = String(error?.message ?? error);
    return {
      ok: false,
      code: code === "cancelled" ? "chatgpt_output_incomplete" : code,
      message: "page_execution_failed",
      diagnostics: invocation.diagnostic
        ? controlDiagnostics(
            objectiveWithCompletionMarker(
              invocation.objective,
              completionMarkerFor(invocation.jobId),
            ),
          )
        : undefined,
      documentToken: DOCUMENT_TOKEN,
    };
  } finally {
    activeJobId = null;
    cancelled = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!primaryContentScript) return false;
  if (message.type === "aialra.probe") {
    const failureCode = failureState();
    void Promise.resolve([]).then((models) =>
      sendResponse({
        pageReady: Boolean(first(SELECTORS.composer)),
        authenticated: authenticated(),
        models,
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
