import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../extension/content-script.js", import.meta.url), "utf8");

function authenticationState(bodyText: string, composerPresent = true) {
  const context = {
    document: { body: { innerText: bodyText } },
    SELECTORS: { composer: ["composer"] },
    first: () => (composerPresent ? {} : null),
  };
  return runInNewContext(
    `${source.slice(source.indexOf("function pageText()"), source.indexOf("function waitForMutation("))}; ({ failureState: failureState(), authenticated: authenticated() })`,
    context,
  ) as { failureState: string | null; authenticated: boolean };
}

describe("browser authentication state", () => {
  it.each([
    "Your session has expired. Please log in again to continue using the app.",
    "Session expired — Log in",
    "会话已过期，请重新登录",
  ])("rejects an expired-session modal even when the composer remains mounted: %s", (text) => {
    expect(authenticationState(text)).toEqual({
      failureState: "chatgpt_login_required",
      authenticated: false,
    });
  });

  it("still accepts a normal authenticated page with a composer", () => {
    expect(authenticationState("Temporary chat Ask anything")).toEqual({
      failureState: null,
      authenticated: true,
    });
  });
});
