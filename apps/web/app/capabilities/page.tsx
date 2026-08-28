import { SiteFooter } from "../../components/site-footer";
import { SiteHeader } from "../../components/site-header";

const capabilities = [
  ["Responses 兼容子集", "已实现", "文本、JSON Schema、服务器发送事件、用量和取消"],
  ["原生 Jobs API", "已实现", "持久队列、幂等、有序事件和固定终态"],
  ["额度感知路由", "已实现", "版本化阈值和接单时固定路由"],
  ["Codex-only 运行时", "已实现", "Luna、Terra 和 Sol 共用一个 Codex Worker 安全边界"],
  [
    "执行隔离",
    "待验收",
    "独立临时工作区与身份目录拒绝规则已实现；Linux 恶意探针通过后才启用 Worker",
  ],
  ["150 项任务评测", "待完成", "固定验收集通过前，不发布真实质量结论"],
];

export default function CapabilitiesPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="shell">
        <header className="page-hero">
          <span className="eyebrow">能力证据账本</span>
          <h1>能力与限制放在同一页</h1>
          <p className="lead">
            当前状态只说明这个版本已经验证的 Codex 能力，不代表兼容所有 OpenAI API 字段
          </p>
        </header>
        <section className="section">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>能力</th>
                  <th>状态</th>
                  <th>证据边界</th>
                </tr>
              </thead>
              <tbody>
                {capabilities.map(([name, status, evidence]) => (
                  <tr key={name}>
                    <td>
                      <strong>{name}</strong>
                    </td>
                    <td
                      className={
                        status === "已实现" ? "success" : status === "待完成" ? "danger" : "warning"
                      }
                    >
                      {status}
                    </td>
                    <td className="muted">{evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
