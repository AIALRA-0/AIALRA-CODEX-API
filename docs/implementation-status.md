# 1 实施状态

版本：`0.1.0` 开发版

日期：2026-09-09

## 1.1 已完成

- TypeScript 单仓库、公共契约与 OpenAPI 生成类型
- Responses 普通响应与 Server-Sent Events 流
- 原生 Jobs、批次、事件、取消、幂等与审批
- Codex 确定性粘性路由与 70、85、95 配额水位
- Codex SDK、App Server 额度与 Luna、Terra、Sol 适配
- PostgreSQL、pg-boss、带记录 AAD 的信封加密、24 小时正文保留和 90 天元数据设计
- Authentik 专用 Group、双层代理证明、认证时间、本地 Passkey、作用域 API Key、HMAC 摘要、PostgreSQL 原子限速与确认吊销
- 受信 Worker 与隔离 Runner 拆分；Runner 不获得数据库连接、正文主密钥或控制面环境变量
- Job、事件、取消、审批和 API 密钥管理按调用者隔离；管理员访问记录真实操作者
- MCP、CLI、TypeScript 客户端与仓库内 Skill
- 黑白中文私有控制台、容器、Tailnet-only Nginx、DNS-only Cloudflare、备份和 GitHub Actions
- 2026-08-26 本地 Codex SDK 冒烟测试返回 `OK`、可恢复线程编号和 `0.048428` Codex Credits
- 2026-08-26 目标 VPS 完成专用 ChatGPT Codex 登录、Luna Responses、SSE、JSON Schema、Jobs、幂等和额度读取验收
- 2026-08-26 Codex 沙箱身份目录与网络隔离探针通过；Worker 探针失败时不会开放接单
- 2026-08-26 Authentik 控制台跳转、公开中文站点、加密备份和备份定时器通过验收
- 2026-08-28 多轮会话开放：`sessionKey` 与 `sessionMode` 生效，新增 `session_threads` 登记表、`GET /api/v1/threads` 与 Runner 会话文件定期清理
- 2026-08-28 新增 `POST /v1/chat/completions` 兼容端点与 CLI `chat`、`threads` 子命令
- 2026-08-28 新增默认关闭的 ChatGPT Pro 网页实验通道；包含回环桥接服务、最小权限 Chrome 扩展、动态网页模型目录、最终正文读取、来源提取和单次发送保护
- 2026-08-28 新增专用可见 Chromium、noVNC、受控出口代理、实验通道开关、`delegate_chatgpt`、CLI `research` 和控制台通道选择
- 2026-08-28 本地合成页面通过模型发现、扩展认证、任务与标签绑定、单次发送、正文稳定和公网来源提取测试
- 2026-08-29 VPS 只读页面探针通过；登录、编辑器、模型菜单、工具菜单和发送按钮均可识别，生产任务提交数为 `0`
- 2026-08-29 真实联网搜索探针成功，普通聊天探针出现空白助手消息并超时；实验通道继续关闭
- 2026-08-29 Chromium 外层沙箱检查通过；受保护可见页面中的 `chrome://sandbox` 管理员核对仍待完成
- 2026-08-29 普通聊天连续稳定门结果为 `1/3`；失败项的用户消息完全匹配、提交次数均为 `1`，但页面留下可见空助手容器；深度研究和完整 `10` 项门禁未启动
- 2026-08-31 收尾契约把普通聊天和搜索固定为每任务新的非个性化 Temporary Chat；2026-09-09 经运营者批准，Deep Research 改为每任务新的普通持久会话并要求显式留存确认；所有网页模式仍拒绝 `sessionKey` 续接，网页提交固定每账号并发 `1` 且至少间隔 90 秒
- 2026-08-31 网页限流统一为 HTTP `429` 与 `chatgpt_rate_limited`，按 30/60/120 分钟冷却；到期只放行一个恢复探针，连续 3 次成功后清除观察态
- 2026-09-09 A/B 独立浏览器账号池、单账号租约、故障摘除、真实单探针和生产调用曾在该次验收中通过；这是历史证据，当前登录和可调度状态必须读取实时账号池
- 2026-09-09 Search 真实任务返回来源，Chat 流式任务成功；Deep Research 使用每任务独立的普通持久会话并要求调用方确认留存风险
- 2026-09-09 API 密钥增加显式通道权限，可选择仅 Codex、仅 ChatGPT 或两者皆可；Codex 工作区权限继续独立控制

## 1.2 当前运行边界

- 网页通道依赖 ChatGPT 页面和人工维护的浏览器登录，不属于官方 API，页面变化、验证码或账号风控会触发自动摘除
- 网页流式响应只提供状态和一次最终完整正文，不伪造逐 Token 增量
- Deep Research 会保留在 ChatGPT 历史中，调用方必须显式确认数据留存风险
- Codex 与网页账号的订阅额度由上游控制，Router 只能分类错误、冷却和安全恢复，不能绕过上游额度或地域限制
- 生产入口只允许受保护网络与 Authentik 身份访问；账号配置卷按登录凭据处理，不进入普通备份
