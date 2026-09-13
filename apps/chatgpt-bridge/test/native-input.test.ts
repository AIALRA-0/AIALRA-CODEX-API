import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

function harness() {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const code = source.slice(
    source.indexOf("async function pasteX11Text("),
    source.indexOf("async function clearX11Clipboard("),
  );
  const clipboard = { kill: vi.fn() };
  const runXdotool = vi.fn(async (args: string[]) => {
    void args;
  });
  const stopClipboard = vi.fn(async () => {});
  const paste = runInNewContext(
    `${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText}; pasteX11Text`,
    {
      findChromiumWindow: async () => "100",
      translateBrowserPoint: async (_id: string, point: { x: number; y: number }) => ({
        x: point.x + 10,
        y: point.y + 20,
      }),
      runXdotool,
      startX11Clipboard: async () => clipboard,
      stopX11Clipboard: stopClipboard,
      setTimeout: (callback: () => void) => callback(),
    },
  );
  return { paste, runXdotool, clipboard, stopClipboard };
}

describe("native input diagnostics", () => {
  it("subtracts window-manager frame offsets before pasting into an unmaximized editor", async () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const code = source.slice(
      source.indexOf("async function translateBrowserPoint("),
      source.indexOf("async function runFocusedXdotoolAtPoint("),
    );
    const translate = runInNewContext(
      `${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText}; translateBrowserPoint`,
      {
        findChromiumWindowGeometry: async () => ({ x: 6, y: 40, width: 1050, height: 875 }),
        findChromiumWindowFrameExtents: async () => ({ left: 1, top: 20 }),
        Math,
      },
    );
    const metrics = {
      screenX: 5,
      screenY: 20,
      outerWidth: 1050,
      outerHeight: 875,
      innerWidth: 1050,
      innerHeight: 788,
      browserChromeWidth: 0,
      browserChromeHeight: 87,
    };
    expect(await translate("100", { x: 594, y: 471 }, { windowMetrics: metrics })).toEqual({
      x: 594,
      y: 471,
    });
  });

  it("keeps coordinates unchanged when the Chromium window is maximized", async () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const code = source.slice(
      source.indexOf("async function translateBrowserPoint("),
      source.indexOf("async function runFocusedXdotoolAtPoint("),
    );
    const translate = runInNewContext(
      `${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText}; translateBrowserPoint`,
      {
        findChromiumWindowGeometry: async () => ({ x: 0, y: 0, width: 1440, height: 900 }),
        findChromiumWindowFrameExtents: async () => ({ left: 0, top: 0 }),
        Math,
      },
    );
    const metrics = {
      screenX: 0,
      screenY: 0,
      outerWidth: 1440,
      outerHeight: 900,
      innerWidth: 1440,
      innerHeight: 813,
      browserChromeWidth: 0,
      browserChromeHeight: 87,
    };
    expect(await translate("100", { x: 594, y: 471 }, { windowMetrics: metrics })).toEqual({
      x: 594,
      y: 471,
    });
  });

  it("traces coordinates and operation stages without retaining input text, with one paste", async () => {
    const h = harness();
    const trace = vi.fn();
    await h.paste("synthetic private input", 10, 20, null, trace);
    expect(trace.mock.calls.map(([stage]) => stage)).toEqual([
      "locating_window",
      "point_translated",
      "clipboard_started",
      "paste_keys_completed",
      "clipboard_released",
    ]);
    expect(trace.mock.calls[1]).toEqual(["point_translated", { x: 20, y: 40 }]);
    expect(JSON.stringify(trace.mock.calls)).not.toContain("synthetic private input");
    expect(h.runXdotool.mock.calls.flat(2).filter((value) => value === "ctrl+v")).toHaveLength(1);
    expect(h.stopClipboard).toHaveBeenCalledOnce();
  });
  it("stops its clipboard owner and propagates a failed native command without retrying", async () => {
    const h = harness();
    h.runXdotool
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("native failure"));
    await expect(h.paste("fixture", 10, 20, null, vi.fn())).rejects.toThrow("native failure");
    expect(h.clipboard.kill).toHaveBeenCalledWith("SIGKILL");
    expect(h.runXdotool).toHaveBeenCalledTimes(2);
  });
});
