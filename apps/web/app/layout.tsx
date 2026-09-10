import type { Metadata } from "next";
import Script from "next/script";
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
    <html lang="zh-CN" data-theme="dark" suppressHydrationWarning>
      <body>
        <a className="skip-link" href="#main">
          跳到正文
        </a>
        {children}
        <Script
          id="aialra-theme-bootstrap"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var key="aialra-theme";var saved=localStorage.getItem(key);var theme=saved==="light"||saved==="dark"?saved:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme}catch(_){document.documentElement.dataset.theme="dark"}})();',
          }}
        />
      </body>
    </html>
  );
}
