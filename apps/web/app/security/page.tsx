import { SiteFooter } from "../../components/site-footer";
import { SiteHeader } from "../../components/site-header";

export default function SecurityPage() {
  const controls = [
    ["凭据隔离", "Codex 认证文件只挂载到专用 Worker，不进入 Web、API、数据库或公开仓库"],
    ["信封加密", "保留的任务、结果和工具事件使用 AES-256-GCM 按记录加密"],
    ["Codex-only 执行", "Worker 只提供 Luna、Terra 和 Sol，不包含其他模型供应商"],
    ["数据保留", "任务正文和工具输出保留 24 小时，脱敏元数据保留 90 天"],
    ["访问控制", "浏览器控制台使用 Authentik 登录；机器接口使用可吊销、带作用域的 API Key"],
    ["漏洞报告", "安全问题先通过私密渠道处理，再决定是否公开讨论"],
  ];
  return (
    <>
      <SiteHeader />
      <main id="main" className="shell">
        <header className="page-hero">
          <span className="eyebrow">安全边界</span>
          <h1>公开页面、登录控制台和机器 API 分开保护</h1>
          <p className="lead">
            公开页面只展示产品证据和合成数据。真实任务、额度、密钥和审计记录需要 Authentik 或 API
            Key
          </p>
        </header>
        <section className="section">
          <div className="grid-3">
            {controls.map(([title, copy], index) => (
              <article className="card" key={title}>
                <span className="card-index">0{index + 1}</span>
                <h3>{title}</h3>
                <p className="muted">{copy}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
