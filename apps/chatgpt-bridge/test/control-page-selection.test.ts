import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const selectionSource = source.slice(
  source.indexOf("function pageFailurePriority("),
  source.indexOf("async function probe(discoverModels"),
);
const selectControlPage = runInNewContext(`${selectionSource}; selectControlPage`) as (
  pages: Array<{ result: Record<string, unknown> }>,
) => Record<string, unknown>;

describe("browser control-page selection", () => {
  it("preserves an expired-session failure when no authenticated page exists", () => {
    expect(
      selectControlPage([
        {
          result: {
            pageReady: true,
            authenticated: false,
            failureCode: "chatgpt_login_required",
            diagnostics: { pageKind: "home" },
          },
        },
      ]),
    ).toMatchObject({
      authenticated: false,
      failureCode: "chatgpt_login_required",
    });
  });

  it("prefers a healthy managed page over an unrelated failed result", () => {
    expect(
      selectControlPage([
        {
          result: {
            pageReady: true,
            authenticated: false,
            failureCode: "chatgpt_login_required",
          },
        },
        {
          result: { pageReady: true, authenticated: true, failureCode: null },
        },
      ]),
    ).toMatchObject({ authenticated: true, failureCode: null });
  });

  it("keeps the most actionable failure when several failures are visible", () => {
    expect(
      selectControlPage([
        {
          result: {
            pageReady: true,
            authenticated: false,
            failureCode: "chatgpt_rate_limited",
          },
        },
        {
          result: {
            pageReady: true,
            authenticated: false,
            failureCode: "chatgpt_verification_required",
          },
        },
      ]),
    ).toMatchObject({ failureCode: "chatgpt_verification_required" });
  });
});
