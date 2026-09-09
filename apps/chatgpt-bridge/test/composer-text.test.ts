import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../extension/content-script.js", import.meta.url), "utf8");
const { composerPlainText, canonicalEditorText } = runInNewContext(
  `${source.slice(source.indexOf("function canonicalEditorText("), source.indexOf("async function nativeSetComposerText("))}; ({composerPlainText, canonicalEditorText})`,
);
const text = (value: string) => ({ nodeType: 3, nodeValue: value });
const element = (tagName: string, childNodes: unknown[] = [], trailing = false) => ({
  nodeType: 1,
  tagName,
  childNodes,
  classList: { contains: (name: string) => trailing && name === "ProseMirror-trailingBreak" },
});
const editor = (value: string) => ({
  children: value
    .split("\n")
    .map((line) => element("P", line ? [text(line)] : [element("BR", [], true)])),
  innerText: value.split("\n").join("\n\n"),
});

describe("exact native editor text", () => {
  it.each([
    "Single paragraph",
    "User: synthetic request\n\nAssistant: synthetic marker",
    "first\nsecond\n\n\nlast",
    "  indented\n    code\n\tmore",
    "中文\nemoji 🚀\ncombining e\u0301",
    "first\n",
  ])("preserves logical text without visual paragraph spacing: %s", (value) => {
    expect(composerPlainText(editor(value))).toBe(value);
  });
  it("preserves inline line breaks and formatting text but excludes padding breaks", () => {
    expect(
      composerPlainText({
        children: [
          element("P", [
            text("a"),
            element("BR"),
            element("STRONG", [text("b")]),
            element("BR", [], true),
          ]),
        ],
      }),
    ).toBe("a\nb");
  });
  it("does not normalize away meaningful whitespace or changed content", () => {
    const value = "one\n\n  two";
    expect(canonicalEditorText(composerPlainText(editor(value)))).not.toBe(
      canonicalEditorText("one two"),
    );
    expect(canonicalEditorText(composerPlainText(editor(value)))).not.toBe(
      canonicalEditorText("one\n\n two"),
    );
  });
  it("falls back for other editors and handles an absent composer", () => {
    expect(composerPlainText({ children: [], innerText: "plain\ntext" })).toBe("plain\ntext");
    expect(composerPlainText(null)).toBe("");
  });
});
