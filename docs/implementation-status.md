# 1 实施状态

版本：`0.1.0` 开发版

日期：2026-08-27

## 1.1 已完成

- TypeScript 单仓库、公共契约与 OpenAPI 生成类型
- Responses 普通响应与 Server-Sent Events 流
- 原生 Jobs、批次、事件、取消、幂等与审批
- Codex-only 确定性粘性路由与 70、85、95 配额水位
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

## 1.2 发布阻断项

- 未导入 30 个匿名真实先导任务与 150 个发布任务
- 未完成 Codex 并发 `1 → 2 → 4` 和 24 小时稳定试验
- 首版已拒绝联网任务；受控出口代理暂不进入可用能力
- 已验证备份文件可读，但尚未完成将备份恢复到独立环境的完整演练
- 未生成首批 GHCR 镜像摘要与软件物料清单
- 当前旧 Git 历史的 `github-safe-publish` 结果仍为 `incomplete`；尚未生成和核验单根发布副本

上述项目通过前，仓库保持私有且 VPS 接单保持关闭；只有精确单根发布副本获得 `pass` 后才允许同名公开重建
