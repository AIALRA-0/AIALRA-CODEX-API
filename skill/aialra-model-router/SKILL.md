---
name: aialra-model-router
description: Convert a bounded AI task into a governed AIALRA Model Router job, preview or enforce deterministic Codex Luna, Terra, or Sol routing, monitor and cancel jobs, validate structured results, and benchmark accepted-result credits. Use for private high-throughput delegation, quota-aware Codex model choice, subscription-capacity calls, MCP delegation, or repeatable model evaluations
---

# AIALRA Model Router

## 1 核心流程

第一步，收敛任务合同

写明目标、必要上下文、约束、预期输出、验证规则、数据等级、权限、期限和预算

只传完成子任务所需的上下文，避免复制父会话

第二步，选择调用方式

优先使用已配置的 `delegate_codex` MCP 工具

MCP 不可用时，运行 `scripts/invoke.mjs`；批量任务运行 `scripts/batch.mjs`

第三步，预览路由

高风险或额度接近阈值时，先调用 `preview_route` 或给脚本传入 `--preview`

需要详细门槛时读取 `references/routing-policy.yaml`

第四步，执行并验证

为每次写调用生成稳定的幂等键

结构化任务必须提供 JSON Schema；可自动检查的文本条件使用 `contains:<文本>`

Schema、测试或质量检查失败时接受 `needs_review`，等待人工确认或显式重跑

第五步，记录结果

记录 Codex Credits、延迟、重试次数、验证结果和人工修正时间

## 2 路由约束

- Luna 处理边界清楚、结构化、可自动验证的高吞吐任务
- Terra 处理编码、调试、集成与审查
- Sol 处理高歧义规划、高风险工作与分歧裁决
- 一个任务生命周期固定一个 Codex 模型和一个推理等级
- 首个输出或工具副作用出现后保持原 Codex 路由
- 同模型只重试一次瞬时容量、网络或临时服务错误
- 质量失败不得触发 Luna、Terra 与 Sol 之间的自动连跳

需要任务分类示例时读取 `references/task-taxonomy.md`

## 3 安全边界

- 默认使用只读文件系统、无网络和 120 秒期限
- 写入或联网必须在任务合同中明确申请，并等待审批事件
- 委派深度固定为 1，子任务不得再次委派
- 同一父任务最多创建 4 个逻辑子任务
- 禁止把 Codex 认证、Tailnet 凭据或 Router API Key 写入提示、日志或输出
- 禁止把个人订阅容量转售或开放给陌生用户

## 4 评测

运行 `scripts/benchmark.mjs` 处理固定 JSONL 任务集

发布路由策略前至少比较 Luna low、Luna medium、Terra medium、Sol high 和自动策略

读取 `references/model-rate-card.json` 获取带生效日期和来源的费率，不凭记忆填充价格

接受结果成本必须包含模型消耗、重试、验证与人工修正
