import { BRIDGE_TOKEN } from "./runtime-config.js";

const BRIDGE_URL = `ws://127.0.0.1:13216/extension?token=${encodeURIComponent(BRIDGE_TOKEN)}`;
const CHATGPT_URL = "https://chatgpt.com/";
const TEMPORARY_CHAT_URL = `${CHATGPT_URL}?temporary-chat=true`;
const STORAGE_KEY = "aialra.chatgpt.single-page-v1.slot";
const ADAPTER_VERSION = "single-page-v1";
const READY_STABILITY_MS = 2_000;
const READY_STABLE_READS = 5;
const ACTIVE_STATES = new Set(["preparing", "ready", "submitted", "generating"]);
const slots = new Map();
const activeJobs = new Map();
const pendingNativeResets = new Map();
let socket = null;
let reconnectTimer = null;
let keepaliveTimer = null;
let discoveredModels = [];
let controlDiagnostics = null;
let pageFailureCode = null;
let restored = false;
let poolMutation = Promise.resolve();

function send(value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function publicSlots() {
  return [...slots.values()].map((slot) => ({
    slotId: slot.slotId,
    state: slot.state,
    documentToken: slot.documentToken ?? null,
    submitted: Boolean(slot.submitted),
    quarantinedUntil: slot.quarantinedUntil ?? null,
    updatedAt: slot.updatedAt,
  }));
}

function activeTabCount() {
  return [...slots.values()].filter((slot) => ACTIVE_STATES.has(slot.state)).length;
}

async function persistSlots() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: [...slots.values()].map((slot) => ({
      slotId: slot.slotId,
      tabId: slot.tabId,
      state: slot.state,
      documentToken: slot.documentToken ?? null,
      submitted: Boolean(slot.submitted),
      jobHash: slot.jobHash ?? null,
      quarantinedUntil: slot.quarantinedUntil ?? null,
      updatedAt: slot.updatedAt,
    })),
  });
}

async function patchSlot(slot, patch) {
  Object.assign(slot, patch, { updatedAt: new Date().toISOString() });
  await persistSlots();
}

async function digestJobId(jobId) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jobId));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sendToTab(tabId, message, attempts = 20) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError ?? new Error("chatgpt_ui_changed");
}

async function waitForReadyPage(
  tabId,
  attempts = 80,
  previousDocumentToken = null,
  deadlineAt = Number.POSITIVE_INFINITY,
  requireEmptyComposer = true,
) {
  let stableDocumentToken = null;
  let stableSince = 0;
  let stableReads = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (Date.now() >= deadlineAt) throw new Error("chatgpt_page_not_ready");
    const page = await sendToTab(tabId, { type: "aialra.probe", discoverModels: false }, 2).catch(
      () => null,
    );
    if (page?.failureCode) throw new Error(page.failureCode);
    const documentToken = page?.diagnostics?.documentToken ?? null;
    const ready =
      page?.pageReady &&
      page?.authenticated &&
      documentToken &&
      documentToken !== previousDocumentToken &&
      page?.diagnostics?.userTurnCount === 0 &&
      page?.diagnostics?.assistantTurnCount === 0 &&
      page?.diagnostics?.generationActive === false &&
      (!requireEmptyComposer || page?.diagnostics?.composerTextLength === 0);
    if (ready) {
      if (documentToken === stableDocumentToken) {
        stableReads += 1;
      } else {
        stableDocumentToken = documentToken;
        stableReads = 1;
        stableSince = Date.now();
      }
      if (stableReads >= READY_STABLE_READS && Date.now() - stableSince >= READY_STABILITY_MS) {
        return page;
      }
    } else {
      stableDocumentToken = null;
      stableSince = 0;
      stableReads = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("chatgpt_browser_unavailable");
}

async function createSlot() {
  const created = await chrome.tabs.create({ url: CHATGPT_URL, active: false });
  if (!created.id) throw new Error("chatgpt_browser_unavailable");
  const slot = {
    slotId: crypto.randomUUID(),
    tabId: created.id,
    state: "starting",
    documentToken: null,
    submitted: false,
    jobHash: null,
    quarantinedUntil: null,
    updatedAt: new Date().toISOString(),
  };
  slots.set(slot.slotId, slot);
  await persistSlots();
  return slot;
}

async function navigateToFreshChat(slot, active, targetUrl = CHATGPT_URL) {
  const tab = await chrome.tabs.get(slot.tabId);
  const currentPage = await sendToTab(
    slot.tabId,
    { type: "aialra.probe", discoverModels: false },
    2,
  ).catch(() => null);
  const previousDocumentToken = currentPage?.diagnostics?.documentToken ?? null;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("chatgpt_browser_unavailable"));
    }, 20_000);
    const onUpdated = (tabId, changeInfo) => {
      if (tabId !== slot.tabId || changeInfo.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const navigation =
      tab.url === targetUrl
        ? chrome.tabs.reload(slot.tabId)
        : chrome.tabs.update(slot.tabId, { url: targetUrl, active });
    void navigation.catch((error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(error);
    });
  });
  await chrome.tabs.update(slot.tabId, { active });
  return previousDocumentToken;
}

async function clearComposerDraft(slot) {
  const composer = await sendToTab(slot.tabId, { type: "aialra.composer-point" }, 4);
  if (!composer?.ok || !composer.point) throw new Error("chatgpt_ui_changed");
  const requestId = crypto.randomUUID();
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingNativeResets.delete(requestId);
      reject(new Error("chatgpt_browser_unavailable"));
    }, 5_000);
    pendingNativeResets.set(requestId, { resolve, timer });
  });
  send({
    type: "native_reset_request",
    requestId,
    x: composer.point.x,
    y: composer.point.y,
  });
  if (!(await result)) throw new Error("chatgpt_browser_unavailable");
}

async function restoreSlots() {
  if (restored) return;
  restored = true;
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  for (const candidate of Array.isArray(stored) ? stored : []) {
    if (!candidate?.slotId || !Number.isInteger(candidate?.tabId)) continue;
    const tab = await chrome.tabs.get(candidate.tabId).catch(() => null);
    if (!tab?.url?.startsWith(CHATGPT_URL)) continue;
    slots.set(candidate.slotId, {
      ...candidate,
      state: "starting",
      documentToken: null,
      submitted: false,
      quarantinedUntil: null,
      updatedAt: new Date().toISOString(),
    });
    break;
  }
  await persistSlots();
}

async function closeRedundantPristineTabs() {
  if (activeJobs.size) return;
  const managedTabIds = new Set([...slots.values()].map((slot) => slot.tabId));
  const tabs = await chrome.tabs.query({ url: `${CHATGPT_URL}*` });
  for (const tab of tabs) {
    if (!tab.id || tab.active || managedTabIds.has(tab.id) || activeJobs.size) continue;
    const page = await sendToTab(tab.id, { type: "aialra.probe", discoverModels: false }, 2).catch(
      () => null,
    );
    const diagnostics = page?.diagnostics;
    const pristine =
      page?.authenticated &&
      !page.failureCode &&
      diagnostics?.freshConversation === true &&
      diagnostics.userTurnCount === 0 &&
      diagnostics.assistantTurnCount === 0 &&
      diagnostics.composerTextLength === 0 &&
      !diagnostics.generationActive;
    if (pristine) await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function resetSlot(slot) {
  await patchSlot(slot, {
    state: "starting",
    documentToken: null,
    submitted: false,
    jobHash: null,
    quarantinedUntil: null,
  });
  const previousDocumentToken = await navigateToFreshChat(slot, false);
  // A browser can restore an unsent draft after a clean restart. First bind to
  // the otherwise empty document, then clear only that managed composer and
  // require the normal fully blank invariant before returning the slot to use.
  let page = await waitForReadyPage(
    slot.tabId,
    80,
    previousDocumentToken,
    Number.POSITIVE_INFINITY,
    false,
  );
  let diagnostics = page.diagnostics ?? {};
  if (diagnostics.composerTextLength > 0) {
    await chrome.tabs.update(slot.tabId, { active: true });
    await clearComposerDraft(slot);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      page = await sendToTab(slot.tabId, { type: "aialra.probe", discoverModels: false }, 2);
      diagnostics = page?.diagnostics ?? {};
      if (diagnostics.composerTextLength === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (
    diagnostics.pageKind !== "home" ||
    diagnostics.userTurnCount !== 0 ||
    diagnostics.assistantTurnCount !== 0 ||
    diagnostics.composerTextLength !== 0 ||
    diagnostics.generationActive
  ) {
    throw new Error("chatgpt_ui_changed");
  }
  await patchSlot(slot, {
    state: "idle",
    documentToken: diagnostics.documentToken ?? null,
    submitted: false,
    jobHash: null,
  });
  return page;
}

async function resetSlotUntilReady(slot, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await resetSlot(slot);
      return true;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  await patchSlot(slot, { state: "starting", documentToken: null });
  if (lastError) console.warn("fresh_chat_reset_failed");
  return false;
}

async function ensurePool() {
  poolMutation = poolMutation
    .catch(() => undefined)
    .then(async () => {
      await restoreSlots();
      while (slots.size < 1) await createSlot();
      for (const extra of [...slots.values()].slice(1)) {
        slots.delete(extra.slotId);
        await chrome.tabs.remove(extra.tabId).catch(() => undefined);
      }
      for (const slot of slots.values()) {
        if (slot.state === "starting") {
          // No task is bound yet, so a slow startup navigation has no failure
          // scene to preserve. Leave the slot in `starting` and retry on the
          // next pool probe instead of blocking the browser for ten minutes.
          await resetSlot(slot).catch(() => undefined);
        }
      }
      await closeRedundantPristineTabs();
    });
  return poolMutation;
}

async function probeSlot(slot, discoverModels) {
  const page = await sendToTab(slot.tabId, { type: "aialra.probe", discoverModels: false }, 2);
  if (
    !discoverModels ||
    activeJobs.size ||
    slot.state !== "idle" ||
    slot.depthDiscoveryBusy ||
    Date.now() - (slot.lastDepthDiscoveryAt ?? 0) < 60_000 ||
    !page?.pageReady ||
    !page.authenticated ||
    page.failureCode ||
    !page.diagnostics?.freshConversation
  )
    return page;
  slot.depthDiscoveryBusy = true;
  let finishDiscovery;
  slot.depthDiscoveryFinished = new Promise((resolve) => {
    finishDiscovery = resolve;
  });
  let previous = null;
  let windowId = null;
  try {
    const tab = await chrome.tabs.get(slot.tabId);
    windowId = tab.windowId;
    [previous] = await chrome.tabs.query({ active: true, windowId });
    if (activeJobs.size || slot.state !== "idle") return page;
    slot.lastDepthDiscoveryAt = Date.now();
    if (previous?.id !== slot.tabId) await chrome.tabs.update(slot.tabId, { active: true });
    let discovered = await sendToTab(slot.tabId, { type: "aialra.probe", discoverModels: true }, 2);
    const hasDepths = (result) => result?.models?.some((model) => model.webThinkingDepths?.length);
    if (!hasDepths(discovered) && slot.depthRecoveryDocument !== page.documentToken) {
      const fresh = await sendToTab(slot.tabId, { type: "aialra.probe", discoverModels: false }, 2);
      if (
        !activeJobs.size &&
        slot.state === "idle" &&
        fresh?.authenticated &&
        !fresh.failureCode &&
        fresh.diagnostics?.freshConversation &&
        fresh.documentToken === page.documentToken
      ) {
        // A restored background document can remain only partially hydrated.
        // Refresh only our empty, authenticated system page, never a draft/login.
        const previousDocument = await navigateToFreshChat(slot, true);
        const ready = await waitForReadyPage(slot.tabId, 80, previousDocument);
        slot.depthRecoveryDocument = ready.documentToken;
        await patchSlot(slot, { documentToken: ready.documentToken });
        discovered = await sendToTab(slot.tabId, { type: "aialra.probe", discoverModels: true }, 2);
      }
    }
    return discovered;
  } finally {
    // Never steal focus from a task or from a tab the administrator chose meanwhile.
    if (previous?.id && previous.id !== slot.tabId && !activeJobs.size && slot.state === "idle") {
      const [current] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
      if (current?.id === slot.tabId)
        await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
    }
    slot.depthDiscoveryBusy = false;
    finishDiscovery();
    slot.depthDiscoveryFinished = null;
  }
}

function pageFailurePriority(code) {
  return (
    {
      chatgpt_verification_required: 0,
      chatgpt_login_required: 1,
      chatgpt_rate_limited: 2,
    }[code] ?? 100
  );
}

function selectControlPage(readyPages) {
  const results = readyPages.map(({ result }) => result).filter(Boolean);
  const healthy = results.find(
    (result) => result.pageReady && result.authenticated && !result.failureCode,
  );
  if (healthy) return healthy;
  const failed = results
    .filter((result) => result.failureCode)
    .sort(
      (left, right) =>
        pageFailurePriority(left.failureCode) - pageFailurePriority(right.failureCode),
    )[0];
  return failed ?? results[0];
}

async function probe(discoverModels = false) {
  await ensurePool();
  const readyPages = [];
  for (const slot of slots.values()) {
    try {
      const result = await probeSlot(slot, discoverModels);
      if (result) readyPages.push({ slot, result });
    } catch {
      // A loading or quarantined tab is represented by its slot state
    }
  }
  const first = selectControlPage(readyPages);
  if (first?.models) discoveredModels = first.models;
  controlDiagnostics = first?.diagnostics ?? null;
  pageFailureCode = first?.failureCode ?? null;
  send({
    type: "models",
    pageReady: Boolean(first?.pageReady),
    authenticated: Boolean(first?.authenticated),
    models: discoveredModels,
    activeTabs: activeTabCount(),
    slots: publicSlots(),
    quarantinedTabs: 0,
    adapterVersion: ADAPTER_VERSION,
    diagnostics: controlDiagnostics,
    failureCode: pageFailureCode,
  });
  return first;
}

async function prepareSlot(slot, invocation) {
  const preparationDeadline = invocation.deadlineAt - 5_000;
  if (Date.now() >= preparationDeadline) throw new Error("chatgpt_page_not_ready");
  await patchSlot(slot, {
    state: "preparing",
    submitted: false,
    jobHash: await digestJobId(invocation.jobId),
    documentToken: null,
    quarantinedUntil: null,
  });
  const temporaryReady =
    invocation.conversationMode === "temporary_per_request" &&
    invocation.temporaryChat === true &&
    invocation.personalized === false;
  const persistentDeepResearchReady =
    invocation.mode === "deep_research" &&
    invocation.conversationMode === "persistent_per_request" &&
    invocation.temporaryChat === false &&
    invocation.personalized === true &&
    invocation.persistenceAcknowledged === true;
  // Begin ordinary chat requests on a new Temporary document directly. Current
  // ChatGPT defaults Temporary Chat to non-personalized; an explicitly observed
  // personalized state is still rejected by the content script before input.
  const previousDocumentToken = await navigateToFreshChat(
    slot,
    true,
    temporaryReady ? TEMPORARY_CHAT_URL : CHATGPT_URL,
  );
  const page = await waitForReadyPage(slot.tabId, 80, previousDocumentToken, preparationDeadline);
  const diagnostics = page.diagnostics ?? {};
  const pageModeReady = temporaryReady
    ? diagnostics.temporaryChatEnabled === true && diagnostics.temporaryChatPersonalized !== true
    : persistentDeepResearchReady && diagnostics.temporaryChatEnabled === false;
  if (!diagnostics.freshConversation || !diagnostics.documentToken || !pageModeReady) {
    throw new Error("chatgpt_ui_changed");
  }
  await patchSlot(slot, { state: "ready", documentToken: diagnostics.documentToken });
  return {
    ...invocation,
    documentToken: diagnostics.documentToken,
  };
}

async function invoke(invocation) {
  if (activeJobs.has(invocation.jobId)) {
    send({
      type: "failed",
      jobId: invocation.jobId,
      code: "chatgpt_delivery_uncertain",
      message: "duplicate_job",
    });
    return;
  }
  await ensurePool();
  const slot = [...slots.values()].find((candidate) => candidate.state === "idle");
  if (!slot) {
    send({
      type: "failed",
      jobId: invocation.jobId,
      code: "chatgpt_browser_unavailable",
      message: "warm_pool_busy",
    });
    return;
  }
  let pageBound = false;
  try {
    if (slot.depthDiscoveryFinished) await slot.depthDiscoveryFinished;
    const boundInvocation = await prepareSlot(slot, invocation);
    // Publish the non-idle slot before accepting browser work so the next
    // caller cannot act on the previous idle snapshot.
    await probe().catch(() => undefined);
    activeJobs.set(invocation.jobId, slot.slotId);
    pageBound = true;
    send({ type: "progress", jobId: invocation.jobId, phase: "opening" });
    const accepted = await sendToTab(slot.tabId, {
      type: "aialra.invoke",
      invocation: boundInvocation,
    });
    if (!accepted?.accepted || accepted.documentToken !== slot.documentToken) {
      throw new Error("chatgpt_delivery_uncertain");
    }
  } catch (error) {
    const code = String(error?.message ?? error);
    const knownCode = [
      "chatgpt_login_required",
      "chatgpt_verification_required",
      "chatgpt_rate_limited",
      "chatgpt_ui_changed",
      "chatgpt_mode_unavailable",
      "chatgpt_delivery_uncertain",
      "chatgpt_output_incomplete",
      "chatgpt_sources_missing",
      "chatgpt_output_incomplete_blank",
      "chatgpt_page_not_ready",
      "chatgpt_page_generation_blank",
      "chatgpt_page_rendering_failed",
      "chatgpt_output_selector_changed",
      "chatgpt_thinking_depth_unavailable",
      "chatgpt_thinking_depth_unverified",
    ].includes(code)
      ? code
      : !pageBound && (code.includes("browser") || code === "chatgpt_ui_changed")
        ? "chatgpt_page_not_ready"
        : code.includes("browser")
          ? "chatgpt_browser_unavailable"
          : "chatgpt_ui_changed";
    send({
      type: "failed",
      jobId: invocation.jobId,
      code: knownCode,
      message: "browser_execution_failed",
    });
    activeJobs.delete(invocation.jobId);
    await resetSlotUntilReady(slot);
    await probe().catch(() => undefined);
  }
}

async function settleInvocation(jobId, result, sender) {
  const slotId = activeJobs.get(jobId);
  const slot = slotId ? slots.get(slotId) : null;
  if (!slot || sender.tab?.id !== slot.tabId) return false;
  activeJobs.delete(jobId);
  const completed = Boolean(result?.ok && result.documentToken === slot.documentToken);
  if (completed) {
    await patchSlot(slot, { state: "completed" });
    send({
      type: "completed",
      jobId,
      outputText: result.outputText,
      sources: result.sources ?? [],
      conversationUrl: result.conversationUrl ?? null,
    });
    await resetSlotUntilReady(slot);
  } else {
    send({
      type: "failed",
      jobId,
      code: result?.code ?? "chatgpt_delivery_uncertain",
      message: result?.message ?? "invoke_failed",
      diagnostics: result?.diagnostics ?? null,
    });
    await resetSlotUntilReady(slot);
  }
  await probe().catch(() => undefined);
  return true;
}

async function cancel(jobId) {
  const slotId = activeJobs.get(jobId);
  const slot = slotId ? slots.get(slotId) : null;
  if (!slot) return;
  try {
    await sendToTab(slot.tabId, { type: "aialra.cancel", jobId }, 2);
  } finally {
    activeJobs.delete(jobId);
    await resetSlotUntilReady(slot);
    void probe();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "aialra.result") {
    void settleInvocation(message.jobId, message.result, sender).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (message.type === "aialra.progress") {
    const slot = slots.get(activeJobs.get(message.jobId));
    if (!slot || sender.tab?.id !== slot.tabId || socket?.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false });
      return false;
    }
    if (message.phase === "submitted")
      void patchSlot(slot, { state: "submitted", submitted: true });
    if (message.phase === "generating")
      void patchSlot(slot, { state: "generating", submitted: true });
    send({
      type: "progress",
      jobId: message.jobId,
      phase: message.phase,
      diagnostics: message.diagnostics ?? null,
    });
    sendResponse({ ok: true });
    return false;
  }
  if (!["aialra.native-click", "aialra.native-input"].includes(message.type)) return false;
  const slot = slots.get(activeJobs.get(message.jobId));
  if (!slot || sender.tab?.id !== slot.tabId || socket?.readyState !== WebSocket.OPEN) {
    sendResponse({ ok: false });
    return false;
  }
  void chrome.tabs
    .get(slot.tabId)
    .then(async (tab) => {
      if (!tab.active) {
        await chrome.tabs.update(slot.tabId, { active: true });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (message.type === "aialra.native-input") {
        send({
          type: "native_input_request",
          jobId: message.jobId,
          action: message.action,
          x: message.x ?? null,
          y: message.y ?? null,
          text: message.text ?? null,
        });
      } else {
        send({
          type: "native_click_request",
          jobId: message.jobId,
          action: message.action,
          x: message.x,
          y: message.y,
        });
      }
      sendResponse({ ok: true });
    })
    .catch(() => sendResponse({ ok: false }));
  return true;
});

function connect() {
  clearTimeout(reconnectTimer);
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;
  const candidate = new WebSocket(BRIDGE_URL);
  socket = candidate;
  candidate.addEventListener("open", async () => {
    if (socket !== candidate) return;
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => send({ type: "keepalive" }), 20_000);
    await ensurePool().catch(() => undefined);
    const result = await probe(true).catch(() => null);
    send({
      type: "hello",
      protocolVersion: 1,
      pageReady: Boolean(result?.pageReady),
      authenticated: Boolean(result?.authenticated),
      models: discoveredModels,
      activeTabs: activeTabCount(),
      slots: publicSlots(),
      quarantinedTabs: 0,
      adapterVersion: ADAPTER_VERSION,
      diagnostics: controlDiagnostics,
      failureCode: pageFailureCode,
    });
  });
  candidate.addEventListener("message", (event) => {
    if (socket !== candidate) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === "native_reset_result") {
        const pending = pendingNativeResets.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingNativeResets.delete(message.requestId);
        pending.resolve(Boolean(message.ok));
      } else if (message.type === "invoke") void invoke(message.invocation);
      else if (message.type === "cancel") void cancel(message.jobId);
      else if (message.type === "probe") void probe(message.discoverModels ?? true);
      else if (message.type === "configure") {
        void ensurePool().then(() => probe(false));
      }
    } catch {
      // Invalid local controller messages are ignored and never forwarded to the page
    }
  });
  candidate.addEventListener("close", () => {
    if (socket !== candidate) return;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    socket = null;
    reconnectTimer = setTimeout(connect, 1_000);
  });
  candidate.addEventListener("error", () => candidate.close());
}

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url?.startsWith(CHATGPT_URL) &&
    activeJobs.size === 0
  ) {
    void probe(false);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const slot = [...slots.values()].find((candidate) => candidate.tabId === tabId);
  if (!slot) return;
  const entry = [...activeJobs.entries()].find(([, slotId]) => slotId === slot.slotId);
  if (entry) {
    const [jobId] = entry;
    activeJobs.delete(jobId);
    send({
      type: "failed",
      jobId,
      code: "chatgpt_delivery_uncertain",
      message: "bound_tab_closed",
    });
  }
  slots.delete(slot.slotId);
  void persistSlots()
    .then(() => ensurePool())
    .then(() => probe(false));
});
setInterval(() => void probe(false), 30_000);
connect();
