# 1 安全政策

## 1.1 支持范围

安全修复只针对最新发布版本和 `main` 分支

仓库进入公开状态前仍按相同流程处理私有披露

## 1.2 报告漏洞

请使用 GitHub 私有漏洞报告功能提交复现条件、影响范围和最小证据

报告中不得包含真实 Codex Token、Router API Key、Passkey 私钥、恢复码或任务正文

项目将在 3 个工作日内确认收到报告，并在完成初步分级后提供后续更新时间

## 1.3 关键边界

- 公共域名不得代理私有 API、控制台、认证或实时额度
- Codex 凭据只允许挂载到独立 Worker
- Worker 只允许调用 Codex Luna、Terra 和 Sol
- Codex 的 `bubblewrap` 需要创建用户命名空间，因此仅 Worker 放宽 Docker seccomp，并使用具名 AppArmor 用户命名空间兼容配置；该配置不作为文件边界，`cap_drop: ALL`、`no-new-privileges`、非 root 用户、只读根文件系统和上线前恶意探针必须同时保留
- 正文和工具输出默认保留 24 小时，脱敏元数据默认保留 90 天
- 个人订阅容量不得转售或提供给陌生用户

完整控制与剩余风险参见 [威胁模型](docs/threat-model.md)
