<div align="center">
<h1>AIALRA Model Router</h1>
<p>把个人 Codex 执行能力和受控 ChatGPT 网页会话接入一个可审计、可恢复的私有调用入口</p>
<p><code>0.1.0 预发布</code> · <code>Apache-2.0</code> · <code>中文控制台</code> · <code>作用域密钥</code></p>
<p><a href="README.en.md">English</a> · <a href="docs/usage.md">使用指南</a> · <a href="docs/api-capabilities.md">接口能力</a> · <a href="docs/deployment.md">部署指南</a> · <a href="SECURITY.md">安全政策</a></p>
</div>

<div align="center">
<img src="docs/assets/console-synthetic.png" width="1440" alt="黑白主题的 AIALRA Model Router 中文控制台，左侧为功能导航，右侧为用量和任务状态">
<p><em>图 1.1　使用合成数据生成的黑白控制台，不含真实账号、任务、地址或内部编号</em></p>
</div>

## 1 项目定位

AIALRA Model Router 是面向账户所有者个人设备和内部自动化的自托管服务

它把调用、排队、执行、验证、历史和权限放进同一个控制面，适合需要统一管理 Codex 编码任务与 ChatGPT 网页任务的个人环境

- Codex 通道使用官方 Codex 命令行工具、TypeScript 软件开发工具包和 App Server，支持一次性任务与可续聊线程
- ChatGPT 网页通道使用独立可见浏览器、最小权限扩展和受控出口，普通聊天与搜索使用每任务独立的临时对话
- Deep Research 使用每任务独立的普通持久对话，调用方必须明确确认内容会进入 ChatGPT 历史记录
- 持久任务队列保存状态、事件、结果和审计记录，连接中断后仍可按任务编号查询
- 作用域密钥可以限制为仅 Codex、仅 ChatGPT 或两种通道，并继续限制 Codex 的执行权限

这不是 OpenAI 官方项目、OpenAI API 服务、订阅转售服务或共享账号服务

网页通道依赖页面结构，可能因登录、验证码、限流或界面变化暂停，系统不会在提交状态不确定时自动重发

## 2 第一次成功调用

### 2.1 运行前提

- Node.js 22 或更高版本
- pnpm 10.33.4
- Docker 29 与 Compose 2.40 或兼容版本
- 一个仅供本项目使用的 Codex 登录目录

### 2.2 启动本地控制面

- 第一步，在仓库根目录安装锁定依赖

```powershell
# 安装当前锁文件声明的全部工作区依赖
pnpm install --frozen-lockfile
```

- 第二步，生成本地密钥并启动 Codex 配置

```powershell
# 准备本地环境，再启动数据库、接口、网页、任务执行器和隔离运行器
pwsh ./deploy/scripts/prepare-local.ps1
docker compose --env-file ./deploy/local.env -f ./deploy/compose.yaml --profile codex up --build -d
```

- 第三步，打开 `http://localhost:13211/setup` 注册第一个 Passkey，并离线保存一次性恢复码
- 第四步，打开 `http://localhost:13211/console/playground`，提交一条最小任务并在调用记录中查看结果

成功时，任务会依次进入接收、排队、执行和验证阶段，最后显示成功结果或明确的失败原因

生产环境的网络、认证、备份和回滚要求见[部署指南](docs/deployment.md)

## 3 接口与权限

- 幂等键（Idempotency Key）：它是调用方为一次写请求生成的唯一标识，用于避免网络重试创建第二个任务；服务端把标识与请求内容绑定，相同标识和相同内容返回原任务，相同标识但不同内容返回冲突；创建任务、密钥和其他可重复写入的操作都应使用它；它不能替代任务编号，也不能让已经提交到外部服务的任务安全重发

<div align="center">
<p><strong>表 3.1　公开调用入口与可观察结果</strong></p>
<table>
<thead><tr><th>入口</th><th>适用场景</th><th>结果</th></tr></thead>
<tbody>
<tr><td><code>POST /v1/responses</code></td><td>文本、结构化输出和统一模型调用</td><td>同步结果或服务端事件流</td></tr>
<tr><td><code>POST /v1/chat/completions</code></td><td>兼容现有聊天客户端</td><td>聊天结果或服务端事件流</td></tr>
<tr><td><code>POST /api/v1/jobs</code></td><td>长任务、批次和异步执行</td><td>任务编号、状态、事件与结果</td></tr>
<tr><td><code>GET /api/v1/quota</code></td><td>查看 Codex 额度快照</td><td>来源、时间和可用水位</td></tr>
<tr><td><code>GET /api/v1/chatgpt-web/status</code></td><td>查看网页账号池</td><td>脱敏健康、租约和冷却状态</td></tr>
</tbody>
</table>
</div>

接口只接受仓库当前明确实现的参数

不支持的 OpenAI 参数返回 `400 unsupported_parameter`，不会被静默忽略

流式调用使用服务器发送事件传递状态和最终完整正文，目前不伪造逐 Token 输出

完整参数、流式事件、错误码和兼容边界见[接口能力说明](docs/api-capabilities.md)，可复制调用示例见[使用指南](docs/usage.md)

### 3.1 最小 Responses 调用

```powershell
# 使用一次显示的作用域密钥提交最小文本任务
$Headers = @{
  Authorization = "Bearer $env:MODEL_ROUTER_API_KEY"
  "Idempotency-Key" = [guid]::NewGuid().ToString()
}
$Body = @{
  model = "luna"
  input = "只返回 OK"
  reasoning = @{ effort = "low" }
} | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri "https://router.example.com/v1/responses" -Headers $Headers -ContentType "application/json" -Body $Body
```

将示例地址替换为自己的受保护地址，并在当前进程中设置密钥

同一次请求因网络问题重试时必须复用原幂等键，新任务必须生成新值

### 3.2 权限选择

<div align="center">
<p><strong>表 3.2　密钥通道与 Codex 执行权限</strong></p>
<table>
<thead><tr><th>选择</th><th>允许的调用</th><th>不允许的调用</th></tr></thead>
<tbody>
<tr><td>仅 Codex</td><td>Codex 模型与持久任务</td><td>ChatGPT 网页任务</td></tr>
<tr><td>仅 ChatGPT</td><td>已启用的网页聊天、搜索或 Deep Research</td><td>Codex 执行</td></tr>
<tr><td>Codex + ChatGPT</td><td>两种通道</td><td>超出密钥期限、速率或执行权限的操作</td></tr>
</tbody>
</table>
</div>

Codex 的 `restricted`、`confirm` 和 `full` 是另一层执行权限，不能扩大密钥已经禁止的调用通道

## 4 运行结构

请求先经过浏览器登录或作用域密钥验证，再写入 PostgreSQL 持久队列

受信 Worker 只负责调度，Codex 任务进入隔离 Runner，网页任务进入指定账号的独立浏览器

任务结果返回前会经过结构、归属和验收检查，随后写入任务历史、事件和审计记录

组件关系、状态转换和会话策略见[架构说明](ARCHITECTURE.md)

## 5 ChatGPT 网页通道

- 普通聊天和搜索固定使用新的 Temporary Chat，要求零历史、非个性化和每任务最多一次提交
- Deep Research 使用新的持久对话，不复用旧对话，也不支持网页 `sessionKey` 续接
- `chatgpt-web.auto` 表示页面自动模型，不是思考深度；`thinking_depth` 用于请求页面实际提供的思考档位
- 每个账号使用独立浏览器配置卷、并发上限 `1`、独立发送间隔、租约、冷却和隔离状态
- 账号套餐使用人工标记的 `plus`、`pro` 或 `unknown`，系统不会从 Cookie、页面文字或响应速度猜测
- 只有明确发生在发送前的失败才允许换到其他健康账号；网页已经接受任务或提交状态不确定后不会换号或重发

网页通道默认关闭

管理员必须先完成无消息就绪检查和一次真实单探针，随后才能让该账号进入生产池

登录、探针、数据风险和错误处理见[ChatGPT 网页通道说明](docs/chatgpt-web-experiment.md)

## 6 安全边界

- 浏览器入口通过 Authentik 保护，机器调用使用可到期、可吊销和有限速的作用域密钥
- API 密钥只保存固定前缀和消息认证码摘要，明文只在创建时显示一次
- 任务正文和事件使用每记录加密，默认正文保留 24 小时，脱敏元数据保留 90 天
- Runner 不获得数据库、正文主密钥、容器套接字或其他任务工作区
- 网页浏览器不获得 Codex 登录、数据库、宿主目录或控制面秘密
- 浏览器配置卷等同登录凭据，不进入普通备份，也不得复制给其他账号
- 仓库示例只使用 `.example.com`、合成任务和占位密钥

处理真实数据、开放外部写入或启用网页自动化前，请先阅读[威胁模型](docs/threat-model.md)和[安全政策](SECURITY.md)

## 7 验证与支持范围

仓库的统一检查命令会依次执行格式、静态检查、类型检查、单元测试和生产构建

```powershell
# 运行仓库当前定义的完整自动化检查
pnpm check
```

修改接口契约后还需运行 `pnpm generate:openapi`，并确认生成步骤没有留下未提交差异

容器配置、隔离、真实 Codex 任务和真实网页任务属于部署验收，不能由本地单元测试代替

当前版本为 `0.1.0` 预发布，兼容范围以仓库内契约和测试为准，不承诺未实现的 OpenAI 参数或网页行为

## 8 文档与协作

- [使用指南](docs/usage.md)提供调用、任务、会话、错误和命令示例
- [接口能力](docs/api-capabilities.md)列出支持参数、流式行为和兼容边界
- [部署指南](docs/deployment.md)说明生产网络、认证、备份、上线和回滚
- [实现状态](docs/implementation-status.md)区分已实现、受条件限制和未支持内容
- [评测方法](docs/evaluation.md)说明路由和质量验证方式
- [贡献指南](CONTRIBUTING.md)说明开发环境和提交前检查
- [安全政策](SECURITY.md)提供私密漏洞报告入口和披露边界

## 9 许可

代码按 [Apache License 2.0](LICENSE) 提供，第三方组件记录见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)

OpenAI、ChatGPT、Codex 及相关标识归其权利人所有
