import type { Metadata } from "next";
import { connection } from "next/server";

import "./globals.css";
import "katex/dist/katex.min.css";

export const metadata: Metadata = {
  title: {
    default: "AIALRA Model Router",
    template: "%s · AIALRA Model Router",
  },
  description: "把 Codex 订阅容量转换为私有 API、持久任务队列和 Agent 委派工具",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Nonce-based CSP requires per-request rendering so Next.js can attach the
  // proxy-generated nonce to every framework and application script.
  await connection();

  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main">
          跳到正文
        </a>
        {children}
      </body>
    </html>
  );
}
