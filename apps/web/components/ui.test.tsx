import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { Disclosure, EmptyState } from "./ui";

describe("shared presentation", () => {
  it("does not call temporary unavailability a closed or unqualified web channel", () => {
    const source = readFileSync(new URL("./console-app.tsx", import.meta.url), "utf8");
    expect(source).toContain('chatGptWebAvailable ? "" : "（暂不可用）"');
    expect(source).not.toContain(
      "ChatGPT 网页实验通道尚未通过真实调用门禁；当前只能使用 Codex 通道",
    );
  });
  it("keeps advanced content accessible in a native, initially collapsed disclosure", () => {
    const html = renderToStaticMarkup(
      <Disclosure title="高级设置">
        <label htmlFor="setting">配置</label>
        <input id="setting" defaultValue="preserved" />
      </Disclosure>,
    );
    expect(html).toContain("<summary>高级设置</summary>");
    expect(html).not.toContain("open=");
    expect(html).toContain('value="preserved"');
    expect(html).toContain('for="setting"');
  });

  it("can reveal a continued session without removing its fields", () => {
    const html = renderToStaticMarkup(
      <Disclosure title="继续会话" open className="console-section">
        <input aria-label="线程" defaultValue="synthetic-thread" />
      </Disclosure>,
    );
    expect(html).toContain('open=""');
    expect(html).toContain("console-section");
    expect(html).toContain('aria-label="线程"');
  });

  it("gives an empty result a heading and an actionable explanation", () => {
    const html = renderToStaticMarkup(<EmptyState title="等待结果">提交后查看结果</EmptyState>);
    expect(html).toContain("<strong>等待结果</strong>");
    expect(html).toContain("<p>提交后查看结果</p>");
  });
});

describe("shared visual tokens", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const token = (name: string) => {
    const match = css.match(new RegExp(`--${name}:\\s*(#[a-f0-9]{6})`, "i"));
    if (!match) throw new Error(`Missing color token: ${name}`);
    return match[1]!;
  };
  const luminance = (hex: string) => {
    const values = [1, 3, 5].map((offset) => {
      const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
  };

  it("keeps text and semantic status colors readable on each surface", () => {
    for (const foreground of ["text", "muted", "quiet", "accent", "success", "danger", "warning"]) {
      for (const background of ["background", "surface", "surface-raised"]) {
        const first = luminance(token(foreground));
        const second = luminance(token(background));
        expect(
          (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
          `${foreground}/${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("defines the formerly missing assistive text and action-group styles", () => {
    expect(css).toMatch(/\.sr-only\s*\{[^}]*clip-path:\s*inset\(50%\)/);
    expect(css).toMatch(/\.action-row\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.check-row\s*\{/);
    expect(css).toMatch(/input\[type="checkbox"\]/);
  });
});
