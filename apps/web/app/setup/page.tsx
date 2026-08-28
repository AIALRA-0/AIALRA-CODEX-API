import { PasskeySetup } from "../../components/passkey-login";

export default function SetupPage() {
  return (
    <main id="main" className="auth-shell">
      <section className="panel auth-card">
        <span className="eyebrow">一次性初始化</span>
        <h2>注册第一个 Passkey</h2>
        <p className="muted">
          仅在服务器启用初始化令牌且尚无管理员时可用。生产环境使用 Authentik 时会关闭这个入口
        </p>
        <PasskeySetup />
      </section>
    </main>
  );
}
