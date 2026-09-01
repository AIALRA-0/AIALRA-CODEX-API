# 1 实施状态

版本：`0.1.0` 开发版

日期：2026-08-31

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
- 2026-08-31 收尾契约固定为每任务新的非个性化 Temporary Chat，拒绝持久会话和 `sessionKey` 续接；网页提交固定并发 `1` 且至少间隔 90 秒
- 2026-08-31 网页限流统一为 HTTP `429` 与 `chatgpt_rate_limited`，按 30/60/120 分钟冷却；到期只放行一个恢复探针，连续 3 次成功后清除观察态

## 1.2 发布阻断项

- 未导入 30 个匿名真实先导任务与 150 个发布任务
- 未完成 Codex 并发 `1 → 2 → 4` 和 24 小时稳定试验
- 首版已拒绝联网任务；受控出口代理暂不进入可用能力
- 已验证备份文件可读，但尚未完成将备份恢复到独立环境的完整演练
- 未生成首批 GHCR 镜像摘要与软件物料清单
- 当前旧 Git 历史的 `github-safe-publish` 结果仍为 `incomplete`；尚未生成和核验单根发布副本
- ChatGPT Pro 网页实验通道尚未取得 4 个普通聊天、4 个搜索和 2 个深度研究的 `9/10` 合格记录；功能开关必须保持关闭
- 实验浏览器容器、noVNC 子路径、出口域名允许清单和浏览器配置卷尚未完成 VPS 攻击探针

源代码仓库当前公开，生产入口仍只允许 Tailnet 访问；上述实验通道门槛通过前不得在生产环境开启 `CHATGPT_WEB_ADAPTER_ENABLED`
