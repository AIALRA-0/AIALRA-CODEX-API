import { createHash } from "node:crypto";

import type { BrowserModel } from "./protocol.js";

export function modelIdForLabel(label: string): string {
  const slug = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  const digest = createHash("sha256").update(label).digest("hex").slice(0, 8);
  return `chatgpt-web.${slug || "model"}.${digest}`;
}

export function normalizeModels(models: BrowserModel[]): BrowserModel[] {
  const unique = new Map<string, BrowserModel>();
  unique.set("chatgpt-web.auto", {
    id: "chatgpt-web.auto",
    displayName: "ChatGPT 网页自动选择",
    available: true,
  });
  for (const model of models) {
    const displayName = model.displayName.trim();
    if (!displayName) continue;
    const id = model.id.startsWith("chatgpt-web.") ? model.id : modelIdForLabel(displayName);
    unique.set(id, { id, displayName, available: model.available });
  }
  return [...unique.values()];
}

export function sanitizeSourceUrls(values: string[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      if (url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com")) continue;
      url.hash = "";
      result.add(url.toString());
    } catch {
      // Ignore malformed and non-web source values from rendered page content
    }
  }
  return [...result];
}

export function isStableOutput(samples: string[], requiredMatches = 2): boolean {
  if (requiredMatches < 2 || samples.length < requiredMatches) return false;
  const tail = samples.slice(-requiredMatches).map((value) => value.trim());
  return Boolean(tail[0]) && tail.every((value) => value === tail[0]);
}

export function fixedBridgeError(code: string): string {
  const messages: Record<string, string> = {
    chatgpt_login_required: "ChatGPT 网页登录已经失效，请在受保护的可见浏览器中重新登录。",
    chatgpt_verification_required: "ChatGPT 网页要求人工验证，请完成验证后重新发起调用。",
    chatgpt_ui_changed: "当前网页结构无法安全识别，实验通道已经拒绝本次调用。",
    chatgpt_rate_limited: "ChatGPT 网页当前限制继续使用，请稍后重新发起调用。",
    chatgpt_timeout: "ChatGPT 网页没有在任务期限内返回可确认的完整结果。",
    chatgpt_delivery_uncertain:
      "系统无法确认消息是否已经成功发送，为防止重复调用，本次不会自动重试。",
    chatgpt_output_incomplete: "系统无法确认网页输出已经完整结束，因此没有返回可能残缺的结果。",
    chatgpt_output_incomplete_blank: "ChatGPT 网页在期限内没有生成可读取的正文。",
    chatgpt_page_not_ready: "ChatGPT 网页在发送前没有完成新对话初始化。",
    chatgpt_page_generation_blank: "ChatGPT 网页创建了助手消息，但页面没有生成可读取的正文。",
    chatgpt_page_rendering_failed: "ChatGPT 网页中存在回答内容，但页面没有把它正常显示出来。",
    chatgpt_output_selector_changed: "ChatGPT 网页已有可见回答，但当前结果定位规则无法提取它。",
    chatgpt_clarification_required: "ChatGPT 要求补充信息，请完善任务合同后重新发起调用。",
    chatgpt_browser_unavailable: "ChatGPT 可见浏览器当前未连接。",
  };
  return messages[code] ?? "ChatGPT 网页实验通道执行失败。";
}
