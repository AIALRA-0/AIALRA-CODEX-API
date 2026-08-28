import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="shell row">
        <span>AIALRA Model Router · Apache-2.0</span>
        <nav className="nav" aria-label="页脚导航">
          <Link href="/docs">使用文档</Link>
          <Link href="/security">安全政策</Link>
          <a href="https://github.com/AIALRA-0/AIALRA-CODEX-API" rel="noreferrer">
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
