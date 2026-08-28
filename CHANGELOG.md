# 1 更新日志

本项目遵循语义化版本

## 未发布

### 修复

- 根路径直接进入私有控制台登录，其余 Web 页面要求 Authentik 身份
- 部署脚本为 Router 自动登记严格匹配的 Authentik OAuth 回调地址
- Web 健康检查改用容器内部可用的登录路由

## 1.1 0.1.0 - 2026-08-25

状态：私有预发布候选

### 1.1.1 新增

- Responses 兼容子集、Jobs API、MCP、CLI 与 TypeScript 客户端
- Luna、Terra 与 Sol 的 Codex-only 确定性粘性路由
- 配额快照、独立成本账本、Schema 验证与审批事件
- Passkey、恢复码、作用域 API Key 与逐记录信封加密
- 中文站点、私有控制台、VPS 部署模板与 GitHub 发布线
- 可复用 `aialra-model-router` Skill

### 1.1.2 限制

- 真实评测集、并发试验、24 小时稳定试验和 VPS 最终验收仍待完成
- 每任务级 rootless Podman Runner 与受控出口代理仍是发布阻断项
