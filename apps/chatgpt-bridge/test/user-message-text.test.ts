import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../extension/content-script.js", import.meta.url), "utf8");
const functions = [
  source.slice(
    source.indexOf("function visibleText("),
    source.indexOf("async function nativeClick("),
  ),
  source.slice(
    source.indexOf("function normalizedText("),
    source.indexOf("function completionMarkerFor("),
  ),
].join("\n");
const { userMessageText, userMessageMatchesObjective } = runInNewContext(
  `${functions}; ({userMessageText, userMessageMatchesObjective})`,
) as {
  userMessageText: (element: unknown) => string;
  userMessageMatchesObjective: (element: unknown, objective: string) => boolean;
};

function userTurn(body: string | string[], control = "", identifiableBody = true) {
  const bodyParts = Array.isArray(body) ? body : [body];
  const button = { innerText: control };
  const messageBodies = bodyParts.map((part) => ({
    innerText: part,
    closest: () => null,
    contains: () => false,
  }));
  return {
    innerText: control ? `${bodyParts.join("\n")} ${control}` : bodyParts.join("\n"),
    querySelectorAll(selector: string) {
      return selector.includes("whitespace-pre-wrap")
        ? identifiableBody
          ? messageBodies
          : []
        : control
          ? [button]
          : [];
    },
  };
}

describe("long user message ownership", () => {
  const objective = "Synthetic input. ".repeat(250);

  it("compares the identifiable message body without a trailing UI control", () => {
    const turn = userTurn(objective, "Show more");
    expect(userMessageText(turn)).toBe(objective.trim());
    expect(userMessageMatchesObjective(turn, objective)).toBe(true);
  });

  it("accepts a known trailing control when the body has no dedicated element", () => {
    expect(userMessageMatchesObjective(userTurn(objective, "Show more", false), objective)).toBe(
      true,
    );
  });

  it("reconstructs a multi-block user turn without including its controls", () => {
    const parts = ["Synthetic heading", "First paragraph", "Second paragraph"];
    const expected = parts.join("\n\n");
    const turn = userTurn(parts, "Edit message");
    expect(userMessageText(turn)).toBe(parts.join("\n"));
    expect(userMessageMatchesObjective(turn, expected)).toBe(true);
  });

  it("rejects changed content and unexplained extra text", () => {
    expect(
      userMessageMatchesObjective(userTurn(`${objective}changed`, "Show more"), objective),
    ).toBe(false);
    expect(
      userMessageMatchesObjective(
        { innerText: `${objective} unknown`, querySelectorAll: () => [] },
        objective,
      ),
    ).toBe(false);
  });

  it("accepts the exact whole turn when dedicated body elements cover only part", () => {
    const turn = userTurn("First paragraph only");
    turn.innerText = objective;
    expect(userMessageText(turn)).toBe("First paragraph only");
    expect(userMessageMatchesObjective(turn, objective)).toBe(true);
    turn.innerText = `${objective} unexplained extra`;
    expect(userMessageMatchesObjective(turn, objective)).toBe(false);
    turn.innerText = objective.slice(0, -30);
    expect(userMessageMatchesObjective(turn, objective)).toBe(false);
  });

  it("accepts exact DOM content in a collapsed turn, rejecting loss or unrelated hidden text", () => {
    const expected = "First paragraph\nSecond paragraph with <literal> punctuation";
    const text = (value: string) => ({ nodeType: 3, nodeValue: value });
    const p = (value: string) => ({ nodeType: 1, tagName: "P", childNodes: [text(value)] });
    const turn = {
      ...userTurn("First paragraph"),
      nodeType: 1,
      tagName: "DIV",
      childNodes: [
        p("First paragraph"),
        p("Second paragraph with <literal> punctuation"),
        { nodeType: 1, tagName: "BUTTON", childNodes: [text("Show more")] },
      ],
    };
    expect(userMessageMatchesObjective(turn, expected)).toBe(true);
    turn.childNodes[1] = p("Second paragraph with changed punctuation");
    expect(userMessageMatchesObjective(turn, expected)).toBe(false);
    turn.childNodes[1] = p("Second paragraph with <literal> punctuation extra");
    expect(userMessageMatchesObjective(turn, expected)).toBe(false);
  });

  it("restores only observed code-node delimiters, including longer inline delimiters", () => {
    const text = (value: string) => ({ nodeType: 3, nodeValue: value });
    const code = (value: string) => ({ nodeType: 1, tagName: "CODE", childNodes: [text(value)] });
    const expected = "Inline `x` then ```literal `tick` code``` end";
    const turn = {
      ...userTurn("Inline x then literal `tick` code end"),
      nodeType: 1,
      tagName: "DIV",
      childNodes: [
        text("Inline "),
        code("x"),
        text(" then "),
        code("literal `tick` code"),
        text(" end"),
      ],
    };
    expect(userMessageMatchesObjective(turn, expected)).toBe(true);
    turn.childNodes[1] = code("y");
    expect(userMessageMatchesObjective(turn, expected)).toBe(false);
    turn.childNodes[1] = text("x");
    expect(userMessageMatchesObjective(turn, expected)).toBe(false);
    turn.childNodes[1] = code("x");
    turn.childNodes[4] = text(" missing ending");
    expect(userMessageMatchesObjective(turn, expected)).toBe(false);
  });

  it("restores trimmed code boundary whitespace only after exact body comparison", () => {
    const text = (value: string) => ({ nodeType: 3, nodeValue: value });
    const code = (value: string) => ({ nodeType: 1, tagName: "CODE", childNodes: [text(value)] });
    const expected = "before ```bash\ncheck draft.md\n``` after";
    const turn = {
      ...userTurn("before bash check draft.md after"),
      nodeType: 1,
      tagName: "DIV",
      childNodes: [text("before "), code("bash\ncheck draft.md"), text(" after")],
    };
    expect(userMessageMatchesObjective(turn, expected)).toBe(true);
    turn.childNodes[1] = code("bash\ncheck other.md");
    expect(userMessageMatchesObjective(turn, expected)).toBe(false);
    turn.childNodes[1] = code("bash\ncheck draft.md extra");
    expect(userMessageMatchesObjective(turn, expected)).toBe(false);
  });
});
