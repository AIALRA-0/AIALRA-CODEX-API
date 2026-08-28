import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="topbar">
      <div className="shell topbar-inner">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span>AIALRA Model Router</span>
        </Link>
        <nav className="nav" aria-label="主导航">
          <Link href="/docs">使用文档</Link>
          <Link href="/capabilities">能力边界</Link>
          <Link href="/evals">评测方法</Link>
          <Link href="/security">安全说明</Link>
          <Link className="button" href="/console">
            打开控制台
          </Link>
        </nav>
      </div>
    </header>
  );
}
