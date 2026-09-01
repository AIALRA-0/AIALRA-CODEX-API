import Link from "next/link";

export function EvaluationMethods({ mode }: { mode: "public" | "console" }) {
  return (
    <>
      <header className="page-hero">
        <span className="eyebrow">可复现评测</span>
        <h1>评测方法</h1>
        <p className="lead">
          比较模型通过率、延迟、Codex Credits 和 API 等效价格，达到规定样本数量后才发布匿名聚合结果
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
          当前数值是合成演示数据，不包含生产额度、账号或真实任务信息
        </p>
      </section>
      <section className="card console-section">
        <h2>评测结果的使用方式</h2>
        <dl className="detail-list">
          <div>
            <dt>比较内容</dt>
            <dd>通过率、延迟、Codex Credits 和 API 等效价格</dd>
          </div>
          <div>
            <dt>发布条件</dt>
            <dd>固定验收规则达到规定样本数量后，才发布匿名聚合结果</dd>
          </div>
          <div>
            <dt>路由关系</dt>
            <dd>评测结果不会自动改变已经发布的路由策略</dd>
          </div>
        </dl>
        <div className="row eval-actions">
          {mode === "console" ? (
            <>
              <Link className="button" href="/console/playground">
                在线调用
              </Link>
              <Link className="button" href="/console/routing">
                路由试算
              </Link>
              <Link className="button" href="/console/jobs">
                调用记录
              </Link>
            </>
          ) : (
            <Link className="button primary" href="/console">
              进入控制台
            </Link>
          )}
        </div>
      </section>
    </>
  );
}
