"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const groups = [
  {
    label: "日常使用",
    items: [
      ["总览", "/console"],
      ["在线调用", "/console/playground"],
      ["路由试算", "/console/routing"],
      ["调用记录", "/console/jobs"],
      ["会话线程", "/console/threads"],
    ],
  },
  {
    label: "资源管理",
    items: [
      ["用量与模型", "/console/models"],
      ["ChatGPT 网页通道", "/console/chatgpt-web"],
      ["API 密钥", "/console/keys"],
    ],
  },
  { label: "测试", items: [["评测方法", "/console/evals"]] },
  {
    label: "安全记录",
    items: [
      ["权限确认", "/console/approvals"],
      ["操作日志", "/console/audit"],
      ["数据清理记录", "/console/retention"],
    ],
  },
] as const;

export function ConsoleNav() {
  const pathname = usePathname();
  return (
    <nav className="console-sidebar" aria-label="控制台导航">
      {groups.map((group) => (
        <section className="console-nav-group" key={group.label} aria-label={group.label}>
          <span className="console-nav-heading">{group.label}</span>
          {group.items.map(([label, href]) => {
            const current = pathname === href;
            return (
              <Link key={href} href={href} aria-current={current ? "page" : undefined}>
                {label}
              </Link>
            );
          })}
        </section>
      ))}
    </nav>
  );
}
