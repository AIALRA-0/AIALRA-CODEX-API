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
});
