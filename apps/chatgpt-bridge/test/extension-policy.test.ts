import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type ExtensionManifest = {
  permissions: string[];
  host_permissions: string[];
};

describe("single-page browser agent policy", () => {
  it("limits page and bridge access to the two required origins", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"),
    ) as ExtensionManifest;

    expect(manifest.permissions.toSorted()).toEqual(["storage", "tabs"]);
    expect(manifest.host_permissions.toSorted()).toEqual([
      "http://127.0.0.1:13216/*",
      "https://chatgpt.com/*",
    ]);
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.permissions).not.toContain("clipboardRead");
    expect(manifest.permissions).not.toContain("downloads");
  });

  it("uses one page, native paste, one send, and immediate fresh-chat reset", () => {
    const contentScript = readFileSync(
      new URL("../extension/content-script.js", import.meta.url),
      "utf8",
    );
    const serviceWorker = readFileSync(
      new URL("../extension/service-worker.js", import.meta.url),
      "utf8",
    );
    const bridgeServer = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

    expect(contentScript).not.toContain("execCommand");
    expect(contentScript).toContain('action: "paste_prompt"');
    expect(contentScript).toContain('action: "clear_clipboard"');
    expect(contentScript).toContain('nativeClick(send, jobId, "send_prompt")');
    expect(contentScript).toContain("async function sendRuntimeMessage");
    expect(contentScript).toContain("const currentComposer = first(SELECTORS.composer)");
    expect(contentScript).toContain("stableReads >= 2");
    expect(contentScript).toContain("completionMarkerFor(invocation.jobId)");
    expect(contentScript).toContain(
      "`${objective} 回答完成后，在最后一行原样输出 ${completionMarker}`",
    );
    expect(contentScript).not.toContain(
      "`${objective}\\n\\n回答完成后，在最后一行原样输出 ${completionMarker}`",
    );
    expect(contentScript).toContain("sample.includes(completionMarker)");
    expect(contentScript).toContain("withoutCompletionMarker(rawOutputText, completionMarker)");
    expect(contentScript).toContain("chatgpt_page_generation_blank");
    expect(contentScript).toContain("chatgpt_output_incomplete_blank");
    expect(contentScript).toContain('kind === "home" || kind === "conversation"');
    expect(contentScript).toContain("users.length !== beforeUserCount + 1");
    expect(contentScript).toContain('"user_echo_verified"');
    expect(contentScript).not.toContain('pageKind() !== "conversation"');
    expect(contentScript).not.toContain("stop_stalled_blank");
    expect(contentScript).not.toContain("regenerate_blank");
    expect(contentScript).not.toContain("recovering_blank_copy");
    expect(contentScript).not.toContain('type: "aialra.native-copy"');

    expect(serviceWorker).toContain("while (slots.size < 1)");
    expect(serviceWorker).toContain("navigateToFreshChat");
    expect(serviceWorker).toContain("resetSlot(slot)");
    expect(serviceWorker).toContain("async function resetSlotUntilReady");
    expect(serviceWorker).toContain("await resetSlotUntilReady(slot)");
    expect(serviceWorker).toContain("const READY_STABILITY_MS = 2_000");
    expect(serviceWorker).toContain("page?.diagnostics?.freshConversation === true");
    expect(serviceWorker).toContain(
      'const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true"',
    );
    expect(serviceWorker).toContain("navigateToFreshChat(slot, true, true)");
    expect(serviceWorker).toContain("diagnostics.temporaryChatEnabled !== true");
    expect(serviceWorker).toContain("diagnostics.temporaryChatPersonalized !== false");
    expect(contentScript).toContain('url.searchParams.get("temporary-chat") === "true"');
    expect(contentScript).toContain("temporaryChatSemanticMarker()");
    expect(contentScript).toContain("unpersonalized|non-personalized");
    expect(contentScript).toContain("return null;");
    expect(serviceWorker).toContain('type: "native_reset_request"');
    expect(serviceWorker).not.toContain("quarantineSlot");
    expect(serviceWorker).not.toContain("rotateSlot");
    expect(serviceWorker).not.toContain("reloadForHydration");
    expect(serviceWorker).not.toContain("setTimeout(resolve, 45_000)");
    expect(serviceWorker).not.toContain("pendingNativeCopies");
    const settleInvocation = serviceWorker.slice(
      serviceWorker.indexOf("async function settleInvocation"),
      serviceWorker.indexOf("async function cancel"),
    );
    expect(settleInvocation.indexOf('type: "completed"')).toBeLessThan(
      settleInvocation.indexOf("await resetSlotUntilReady(slot)"),
    );
    expect(settleInvocation.indexOf('type: "failed"')).toBeLessThan(
      settleInvocation.lastIndexOf("await resetSlotUntilReady(slot)"),
    );

    expect(bridgeServer).toContain('message.type === "native_reset_request"');
    expect(bridgeServer).toContain('"ctrl+v"');
    expect(bridgeServer).toContain('spawn("xclip"');
    expect(bridgeServer).toContain("clearX11Clipboard");
    expect(bridgeServer).toContain("async function runFocusedXdotool");
    expect(bridgeServer).toContain('["windowactivate", "--sync", windowId]');
    expect(bridgeServer).toContain("setTimeout(resolve, 1_000)");
    expect(bridgeServer).not.toContain("copyX11Text");
    expect(contentScript).toContain("setTimeout(resolve, 750)");
    expect(contentScript.match(/submitComposer\(send, invocation\.jobId\)/g)).toHaveLength(1);
  });

  it("can disable the unpacked extension for an isolated browser comparison", () => {
    const entrypoint = readFileSync(
      new URL("../../../deploy/chatgpt-browser/entrypoint.sh", import.meta.url),
      "utf8",
    );
    const compose = readFileSync(new URL("../../../deploy/compose.yaml", import.meta.url), "utf8");
    const diagnosticCompose = readFileSync(
      new URL("../../../deploy/compose.chatgpt-diagnostic.yaml", import.meta.url),
      "utf8",
    );

    expect(entrypoint).toContain("CHATGPT_BROWSER_EXTENSION_ENABLED:-true");
    expect(entrypoint).toContain('if [ "$extension_enabled" = "true" ]');
    expect(entrypoint).toContain('elif [ "$extension_enabled" != "false" ]');
    expect(compose).toContain(
      "CHATGPT_BROWSER_EXTENSION_ENABLED: ${CHATGPT_BROWSER_EXTENSION_ENABLED:-true}",
    );
    expect(diagnosticCompose).toContain(
      "CHATGPT_BROWSER_EXTENSION_ENABLED: ${CHATGPT_BROWSER_EXTENSION_ENABLED:-false}",
    );
    expect(diagnosticCompose).toContain("chatgpt_browser_diagnostic_profile");
    expect(diagnosticCompose).toContain('CHATGPT_WEB_ADAPTER_ENABLED: "false"');
    const qualificationScript = readFileSync(
      new URL("../../../deploy/scripts/qualify-chatgpt-web.mjs", import.meta.url),
      "utf8",
    );
    expect(qualificationScript).toContain("async function waitForReadyHealth");
  });
});
