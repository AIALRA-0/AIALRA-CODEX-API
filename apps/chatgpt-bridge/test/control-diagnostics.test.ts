import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../extension/content-script.js", import.meta.url), "utf8");
const safeControlLabel = runInNewContext(
  `${source.slice(source.indexOf("function safeControlLabel("), source.indexOf("function describeControl("))}; safeControlLabel`,
);

describe("control diagnostic redaction", () => {
  it("does not search sidebar label substrings for a model control", () => {
    const selectors = [
      "model-switcher-test-id",
      "model-selector-test-id",
      "aria-model",
      "aria-模型",
    ];
    const searched: string[][] = [];
    const getControl = runInNewContext(
      `${source.slice(source.indexOf("function modelControlForComposer("), source.indexOf("let thinkingDepthDiscoveryDiagnostics"))}; modelControlForComposer`,
      {
        SELECTORS: { composer: [], modelButton: selectors },
        first: () => null,
        firstVisible: (values: string[]) => {
          searched.push(values);
          return null;
        },
      },
    );
    expect(getControl()).toBeNull();
    expect(searched).toEqual([selectors.slice(0, 2)]);
  });

  it("never copies conversation titles or attachment names through keyword matches", () => {
    for (const label of [
      "Pin synthetic model conversation",
      "Pin synthetic 模型 prompt",
      "Remove model-private-file.txt",
      "Archive Tools discussion",
      "user@example.com",
    ]) {
      expect(safeControlLabel(label)).toBeNull();
    }
  });
  it("returns action categories rather than dynamic label suffixes", () => {
    expect(safeControlLabel("Share synthetic conversation title")).toBe("share");
    expect(safeControlLabel("Select model: synthetic private label")).toBe("model");
    expect(safeControlLabel("Add files and more")).toBe("add");
    expect(safeControlLabel("Start dictation")).toBe("dictation");
    expect(safeControlLabel("发送消息")).toBe("send");
  });
});
