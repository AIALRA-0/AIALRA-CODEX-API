import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { Disclosure, EmptyState } from "./ui";
import { ThemeToggle } from "./theme-toggle";

describe("shared presentation", () => {
  it("does not call temporary unavailability a closed or unqualified web channel", () => {
    const source = readFileSync(new URL("./console-app.tsx", import.meta.url), "utf8");
    expect(source).toContain('chatGptWebAvailable ? "" : "（暂不可用）"');
    expect(source).not.toContain(
      "ChatGPT 网页实验通道尚未通过真实调用门禁；当前只能使用 Codex 通道",
    );
  });

  it("keeps the synthetic overview disconnected from runtime APIs", () => {
    const source = readFileSync(new URL("./console-app.tsx", import.meta.url), "utf8");
    expect(source).toContain("if (syntheticDemo) {");
    expect(source).toMatch(/if \(syntheticDemo\) \{[\s\S]*?setJobs\(\[\]\);[\s\S]*?return;/);
    expect(source).toMatch(/\},\s*\[syntheticDemo\],\s*\);/);
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

  it("renders a persistent and accessible black-and-white theme control", () => {
    const html = renderToStaticMarkup(<ThemeToggle />);
    const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
    expect(html).toContain('class="theme-toggle"');
    expect(html).toContain('aria-label="切换为白色主题"');
    expect(html).toContain("黑 / 白");
    expect(layout).toContain("localStorage.getItem(key)");
    expect(layout).toContain('strategy="beforeInteractive"');
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

  it("uses only achromatic color tokens in both themes", () => {
    const colorTokens = [...css.matchAll(/--([a-z-]+):\s*(#[a-f0-9]{6})/gi)]
      .filter(([, name]) => !name!.startsWith("status-"))
      .map(([, , value]) => value!);
    expect(colorTokens.length).toBeGreaterThan(20);
    for (const hex of colorTokens) {
      const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
      expect(new Set(channels).size, hex).toBe(1);
    }
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain(':root[data-theme="dark"]');
  });

  it("reserves traffic-light colors for visible status indicators", () => {
    const consoleSource = readFileSync(new URL("./console-app.tsx", import.meta.url), "utf8");
    expect(css).toMatch(/--status-success:\s*#[a-f0-9]{6}/i);
    expect(css).toMatch(/--status-warning:\s*#[a-f0-9]{6}/i);
    expect(css).toMatch(/--status-danger:\s*#[a-f0-9]{6}/i);
    expect(css).toContain(".status-indicator.success::before");
    expect(css).toContain(".status-indicator.warning::before");
    expect(css).toContain(".status-indicator.danger::before");
    expect(css).toMatch(/\.status-dot\s*\{[\s\S]*?background:\s*var\(--status-success\)/);
    expect(consoleSource).toContain('if (status === "succeeded") return "success";');
    expect(consoleSource).toContain('["failed", "cancelled", "expired"]');
    expect(consoleSource).toMatch(/return "warning";\s*\}/);
  });

  it("shows API key channels separately from Codex workspace permissions", () => {
    const source = readFileSync(new URL("./console-app.tsx", import.meta.url), "utf8");
    expect(source).toContain("仅 Codex");
    expect(source).toContain("仅 ChatGPT");
    expect(source).toContain("Codex + ChatGPT");
    expect(source).toContain("Codex 执行权限不适用");
    expect(source).toContain("executionChannels");
    expect(css).toMatch(/\.choice-card:has\(input:checked\)/);
  });

  it("explains and locks real web probes while diagnostic mode is disabled", () => {
    const source = readFileSync(new URL("./console-app.tsx", import.meta.url), "utf8");
    expect(source).toContain("真实网页检查当前已锁定");
    expect(source).toContain("!status.diagnosticEnabled");
    expect(source).toContain("生产接单，检查按钮已锁定");
  });

  it("explains common ChatGPT account failures in user-facing language", () => {
    const source = readFileSync(new URL("./console-app.tsx", import.meta.url), "utf8");
    expect(source).toContain('chatgpt_login_required: "登录已过期，请在对应浏览器中重新登录"');
    expect(source).toContain('chatgpt_delivery_uncertain: "发送状态无法确认，系统不会自动重发"');
    expect(source).toContain("chatGptErrorLabel(account.lastFailureCode)");
  });
});
