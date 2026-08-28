"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const sections = [
  ["总览", "overview"],
  ["在线调用", "playground"],
  ["任务", "jobs"],
  ["路由预览", "routing"],
  ["模型与额度", "models"],
  ["API 密钥", "keys"],
  ["审计", "audit"],
  ["删除回执", "retention"],
];

export function ConsoleNav() {
  const pathname = usePathname();
  return (
    <nav className="console-sidebar" aria-label="控制台导航">
      {sections.map(([label, section]) => {
        const href = section === "overview" ? "/console" : `/console/${section}`;
        const current = pathname === href;
        return (
          <Link key={section} href={href} aria-current={current ? "page" : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
