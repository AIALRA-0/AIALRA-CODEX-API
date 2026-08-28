import { SiteFooter } from "../../components/site-footer";
import { SiteHeader } from "../../components/site-header";

export default function EvalsPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="shell">
        <header className="page-hero">
          <span className="eyebrow">可复现评测</span>
          <h1>衡量每个合格结果的成本</h1>
          <p className="lead">
            完成 150 项固定任务验收后才会发布匿名聚合结果。以下数值只用于展示界面
          </p>
        </header>
        <section className="section">
          <div className="metrics">
            <article className="metric">
              <small>Schema 通过率</small>
              <strong>97.4%</strong>
              <div className="progress">
                <span style={{ width: "97.4%" }} />
              </div>
            </article>
            <article className="metric">
              <small>复核后接受率</small>
              <strong>99.1%</strong>
              <div className="progress">
                <span style={{ width: "99.1%" }} />
              </div>
            </article>
            <article className="metric">
              <small>相对 Terra 基线</small>
              <strong>54%</strong>
              <div className="progress">
                <span style={{ width: "54%" }} />
              </div>
            </article>
          </div>
          <p className="muted" style={{ marginTop: "1rem" }}>
            仅为合成演示数据，不包含生产额度、账号或真实任务信息
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
