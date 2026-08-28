import { PasskeyLogin } from "../../components/passkey-login";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const value = await searchParams;
  const returnTo = value.returnTo?.startsWith("/console") ? value.returnTo : "/console";
  return (
    <main id="main" className="auth-shell">
      <section className="panel auth-card">
        <span className="eyebrow">
          <span className="status-dot" /> 本地 Passkey 备用登录
        </span>
        <h2>登录管理控制台</h2>
        <p className="muted">生产环境优先使用 Authentik；本页用于本地部署的 Passkey 或恢复码</p>
        <PasskeyLogin returnTo={returnTo} />
      </section>
    </main>
  );
}
