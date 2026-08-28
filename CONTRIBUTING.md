# 1 贡献指南

## 1.1 开发要求

- Node.js 22 或更高版本
- pnpm 10.33.4
- Docker 29 与 Compose 2.40 或兼容版本

## 1.2 本地流程

第一步，安装锁定依赖

运行 `pnpm install --frozen-lockfile`

第二步，修改契约时重新生成客户端类型

运行 `pnpm generate:openapi`

第三步，运行完整门槛

运行 `pnpm check`

第四步，涉及部署时验证 Compose

设置合成 WebAuthn 域名与来源，再运行 `docker compose -f deploy/compose.yaml config --quiet`

## 1.3 变更边界

- 新增 Responses 字段前先修改 `openapi/openapi.yaml`
- 路由规则必须提升策略版本并提供确定性测试
- 新增外发能力必须更新威胁模型与数据扫描测试
- 禁止提交真实凭据、真实任务、内部主机名、Tailnet FQDN 或账号截图
- 公开性与原创性描述必须使用限定证据，避免唯一性断言
