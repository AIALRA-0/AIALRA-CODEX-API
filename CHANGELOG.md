# 1 更新日志

本项目遵循语义化版本

## 未发布

### 新增

- 多轮会话：任务合同新增 `sessionMode`，`sessionKey` 正式开放；新增会话线程登记表与 `GET /api/v1/threads`，模型与推理档位按线程粘性保持
- `POST /v1/chat/completions` 兼容端点：标准 OpenAI 客户端更换 `base_url` 即可调用，支持流式、`response_format` 与 `aialra` 扩展
- Runner 按 `CODEX_SESSION_TTL_MS` 定期清理到期会话文件（默认 24 小时）
- 控制台新增「会话线程」页，在线调用支持保留会话与继续线程
- CLI 新增 `chat`、`threads` 子命令与 `--session`、`--session-key` 参数
- TypeScript 客户端新增 `createChatCompletion` 与 `listSessionThreads`
- 默认关闭的 ChatGPT Pro 网页实验通道：可见 Chromium、最小权限扩展、回环桥接服务、动态网页模型目录和最终完整正文返回
- 网页实验任务进入 Jobs、Responses、CLI 和 MCP；新增 `chatgpt:web` 密钥作用域、`research` 命令和 `delegate_chatgpt` 工具
- 网页用量缺失时统一返回 `measurementStatus: unavailable`，禁止以 `0` 代替 Token、Credits、额度变化或 API 等效价格
- VPS 可选部署新增 noVNC 人工登录入口、独立浏览器配置卷和拒绝内网目的地的受控出口代理

### 修复

- 根路径直接进入私有控制台登录，其余 Web 页面要求 Authentik 身份
- 部署脚本为 Router 自动登记严格匹配的 Authentik OAuth 回调地址
- Web 健康检查改用容器内部可用的登录路由
- Chat Completions 流式映射在网页通道没有文本增量时发送最终完整正文

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
