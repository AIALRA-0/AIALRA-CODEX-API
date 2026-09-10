import Link from "next/link";
import { ConsoleNav } from "../../components/console-nav";
import { ThemeToggle } from "../../components/theme-toggle";

export default function ConsoleLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <header className="topbar">
        <div className="shell topbar-inner">
          <Link className="brand" href="/">
            <span className="brand-mark">A</span>
            <span>AIALRA Model Router</span>
          </Link>
          <div className="row console-account">
            <ThemeToggle />
            <span className="status-chip">
              <span className="status-dot" />
              <span className="status-text">
                {process.env.NEXT_PUBLIC_SYNTHETIC_DEMO === "true"
                  ? "界面预览"
                  : "Authentik 已保护"}
              </span>
            </span>
            <a className="button compact" href="/_aialra_auth/logout">
              退出
            </a>
          </div>
        </div>
      </header>
      <div className="console-shell">
        <ConsoleNav />
        {children}
      </div>
    </>
  );
}
