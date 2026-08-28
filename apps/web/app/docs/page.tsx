import { SiteFooter } from "../../components/site-footer";
import { SiteHeader } from "../../components/site-header";

const requestExample = `$RouterUrl = "https://router.example.com" # 使用部署者提供的 HTTPS API 地址
$Headers = @{ # 使用作用域密钥认证，并让网络重试保持幂等
  Authorization = "Bearer $env:MODEL_ROUTER_API_KEY" # 从进程环境读取 API Key，避免把密钥写入脚本
  "Idempotency-Key" = [guid]::NewGuid().ToString() # 重试同一业务请求时复用这个值
}
$Body = @{ # 用安全默认权限描述一个边界清楚的任务
  task = @{
    objective = "把合成告警分为通知、行动项或垃圾信息" # 只写一个可验收目标
    taskKind = "bounded" # 让确定性策略优先选择 Luna
    model = "auto" # 由策略选模型，并把决定保存在任务记录中
    permissions = @{ filesystem = "read"; network = "none" } # 禁止文件写入和网络访问
  }
} | ConvertTo-Json -Depth 6 # 保留任务合同中的嵌套字段
Invoke-RestMethod -Method Post -Uri "$RouterUrl/api/v1/jobs" -Headers $Headers -ContentType "application/json" -Body $Body # 创建持久任务`;

export default function DocsPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="shell">
        <header className="page-hero">
          <span className="eyebrow">使用文档</span>
          <h1>用一个请求提交受治理的 Codex 任务</h1>
          <p className="lead">
            提交明确的任务合同，固定本次任务的路由，并获得输出、验证、用量和审计记录
          </p>
        </header>
        <div className="doc-layout">
          <nav className="doc-nav" aria-label="文档章节">
            <a href="#quickstart">快速开始</a>
            <a href="#choose">选择调用方式</a>
            <a href="#contract">任务合同</a>
            <a href="#events">事件流</a>
            <a href="#routing">路由规则</a>
            <a href="#errors">错误处理</a>
            <a href="#interfaces">MCP 与 CLI</a>
          </nav>
          <div className="doc-content">
            <section id="quickstart">
              <h2>快速开始</h2>
              <p>
                本地使用时，启动 4 个 Compose 服务，打开 <code>http://localhost:13211/setup</code>
                完成初始化，再到 <code>/console/playground</code> 提交第一个任务
              </p>
              <p>
                Agent 调用时，连接部署者提供的 HTTPS 地址，携带作用域 API
                Key；重试同一请求时复用原幂等键
              </p>
              <pre className="code-panel">{requestExample}</pre>
              <p>
                本页只使用合成示例。真实任务、额度和密钥需要通过 Authentik 控制台或 API Key 访问
              </p>
            </section>
            <section id="choose">
              <h2>选择调用方式</h2>
              <p>
                Responses 适合同步或流式的模型式调用；Jobs 适合持久队列、恢复、审批和审计；CLI
                适合脚本，TypeScript 客户端适合 Node.js 应用，MCP 适合 Agent 委派边界清楚的子任务
              </p>
            </section>
            <section id="contract">
              <h2>任务合同</h2>
              <p>
                除必填目标外，还可以明确必要上下文、约束、预期输出、验证规则、数据等级、权限、期限、预算和
                Codex 模型偏好
              </p>
            </section>
            <section id="events">
              <h2>事件流</h2>
              <p>
                Jobs 按顺序发布状态、文本增量、工具、审批、验证、用量和错误事件。添加
                <code>stream=true</code> 或请求 <code>text/event-stream</code> 可接收流式结果
              </p>
            </section>
            <section id="routing">
              <h2>路由规则</h2>
              <p>
                版本化确定性策略在接单时选择模型。首个输出或工具副作用出现后，路由不再切换。边界清楚的任务可使用
                Luna，工程任务可使用 Terra，高歧义或高风险任务可使用 Sol
              </p>
            </section>
            <section id="errors">
              <h2>错误处理</h2>
              <p>
                未支持的 Responses 字段返回 <code>400 unsupported_parameter</code>
                。同一幂等键对应不同请求摘要时返回 <code>409 idempotency_conflict</code>
              </p>
            </section>
            <section id="interfaces">
              <h2>MCP 与 CLI</h2>
              <p>
                MCP 服务提供委派、路由预览、状态、取消和额度工具。委派深度限制为
                1，子任务不能继续委派。CLI 提供 call、batch、jobs、cancel、eval 和 quota 命令
              </p>
            </section>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
