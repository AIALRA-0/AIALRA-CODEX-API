import { z } from "zod";

export const ModelAliasSchema = z.enum(["auto", "luna", "terra", "sol"]);
export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export const ModelSelectionSchema = z.union([
  ModelAliasSchema,
  z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
]);
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const ReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const DataClassificationSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
export type DataClassification = z.infer<typeof DataClassificationSchema>;

export const PermissionProfileSchema = z.object({
  filesystem: z.enum(["none", "read", "write"]).default("read"),
  network: z.enum(["none", "allowlist"]).default("none"),
  allowedHosts: z.array(z.string().min(1)).max(32).default([]),
  requireApprovalForWrites: z.boolean().default(true),
  requireApprovalForExternalActions: z.boolean().default(true),
});
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

export const TaskBudgetSchema = z.object({
  maxCodexCredits: z.number().positive().optional(),
  maxOutputTokens: z.number().int().positive().max(128_000).default(8_192),
  maxAttempts: z.number().int().min(1).max(2).default(2),
});
export type TaskBudget = z.infer<typeof TaskBudgetSchema>;

export const ValidationContractSchema = z.object({
  responseSchema: z.record(z.string(), z.unknown()).optional(),
  acceptanceTests: z.array(z.string().min(1)).max(32).default([]),
});
export type ValidationContract = z.infer<typeof ValidationContractSchema>;

export const TaskContractSchema = z.object({
  objective: z.string().min(1).max(100_000),
  taskKind: z
    .enum(["bounded", "coding", "review", "planning", "batch", "general"])
    .default("general"),
  requiredContext: z.array(z.string()).max(128).default([]),
  constraints: z.array(z.string()).max(128).default([]),
  expectedOutput: z.string().max(20_000).default("Return the completed result."),
  validation: ValidationContractSchema.default({ acceptanceTests: [] }),
  dataClassification: DataClassificationSchema.default("internal"),
  permissions: PermissionProfileSchema.default({
    filesystem: "read",
    network: "none",
    allowedHosts: [],
    requireApprovalForWrites: true,
    requireApprovalForExternalActions: true,
  }),
  deadlineMs: z.number().int().min(1_000).max(3_600_000).default(120_000),
  budget: TaskBudgetSchema.default({ maxOutputTokens: 8_192, maxAttempts: 2 }),
  sessionKey: z.string().min(1).max(256).optional(),
  model: ModelSelectionSchema.default("auto"),
  effort: ReasoningEffortSchema.default("medium"),
  replayable: z.boolean().default(true),
  ambiguity: z.number().int().min(0).max(4).default(1),
  risk: z.number().int().min(0).max(4).default(1),
});
export type TaskContract = z.infer<typeof TaskContractSchema>;

export const CreateJobRequestSchema = z.object({
  task: TaskContractSchema,
  metadata: z.record(z.string(), z.string().max(2_000)).default({}),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const JobStatusSchema = z.enum([
  "accepted",
  "queued",
  "running",
  "validating",
  "succeeded",
  "needs_review",
  "failed",
  "cancelled",
  "expired",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const RouteDecisionSchema = z.object({
  provider: z.literal("codex"),
  model: z.string().min(1),
  effort: ReasoningEffortSchema,
  policyVersion: z.string().min(1),
  reasonCode: z.string().min(1),
  sticky: z.literal(true),
});
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

export const UsageLedgerSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  codexCredits: z.number().nonnegative().nullable().default(null),
  apiEquivalentUsd: z.number().nonnegative().nullable().default(null),
  quotaUsedPercentBefore: z.number().min(0).max(100).nullable().default(null),
  quotaUsedPercentAfter: z.number().min(0).max(100).nullable().default(null),
  quotaWindowDeltaPercent: z.number().min(0).max(100).nullable().default(null),
  allocatedSubscriptionUsd: z.number().nonnegative().nullable().default(null),
});
export type UsageLedger = z.infer<typeof UsageLedgerSchema>;

export const ValidationResultSchema = z.object({
  passed: z.boolean(),
  schemaPassed: z.boolean().nullable().default(null),
  testsPassed: z.number().int().nonnegative().default(0),
  testsFailed: z.number().int().nonnegative().default(0),
  messages: z.array(z.string()).default([]),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const JobEventSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  type: z.enum(["status", "output.delta", "tool", "approval", "validation", "usage", "error"]),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type JobEvent = z.infer<typeof JobEventSchema>;

export const JobSchema = z.object({
  id: z.string().uuid(),
  status: JobStatusSchema,
  requestHash: z.string().min(1),
  idempotencyKey: z.string().min(1).nullable(),
  callerId: z.string().min(1),
  task: TaskContractSchema,
  route: RouteDecisionSchema.nullable(),
  output: z.unknown().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  usage: UsageLedgerSchema,
  validation: ValidationResultSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type Job = z.infer<typeof JobSchema>;

export const QuotaWindowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["primary", "secondary"]),
  usedPercent: z.number().min(0).max(100).nullable(),
  remainingPercent: z.number().min(0).max(100).nullable(),
  windowDurationMinutes: z.number().nonnegative().nullable(),
  resetsAt: z.string().datetime().nullable(),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

export const QuotaSnapshotSchema = z.object({
  provider: z.literal("codex"),
  usedPercent: z.number().min(0).max(100).nullable(),
  windowDurationMinutes: z.number().nonnegative().nullable(),
  resetsAt: z.string().datetime().nullable(),
  planType: z.string().nullable(),
  fetchedAt: z.string().datetime(),
  source: z.enum(["app-server", "unavailable"]),
  windows: z.array(QuotaWindowSchema).default([]),
  stale: z.boolean().default(false),
});
export type QuotaSnapshot = z.infer<typeof QuotaSnapshotSchema>;

export const ModelRateSchema = z.object({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative(),
  output: z.number().nonnegative(),
  currency: z.enum(["credits", "USD"]),
  unit: z.literal("million_tokens"),
  effectiveDate: z.string(),
  source: z.string().url(),
});
export type ModelRate = z.infer<typeof ModelRateSchema>;

export const RuntimeModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  available: z.boolean(),
  enabled: z.boolean(),
  hidden: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  supportedReasoningEfforts: z.array(ReasoningEffortSchema),
  defaultReasoningEffort: ReasoningEffortSchema.nullable(),
  inputModalities: z.array(z.string()),
  creditRate: ModelRateSchema.nullable(),
  apiRate: ModelRateSchema.nullable(),
  rateStatus: z.enum(["available", "unavailable"]),
  discoveredAt: z.string().datetime(),
});
export type RuntimeModel = z.infer<typeof RuntimeModelSchema>;

export const ModelCatalogSnapshotSchema = z.object({
  models: z.array(RuntimeModelSchema.omit({ enabled: true })),
  fetchedAt: z.string().datetime(),
  source: z.enum(["app-server", "unavailable"]),
});
export type ModelCatalogSnapshot = z.infer<typeof ModelCatalogSnapshotSchema>;

export const ResponsesRequestSchema = z
  .object({
    model: ModelSelectionSchema.default("auto"),
    input: z.union([z.string(), z.array(z.unknown())]),
    instructions: z.string().optional(),
    reasoning: z.object({ effort: ReasoningEffortSchema.optional() }).optional(),
    text: z
      .object({
        format: z
          .object({
            type: z.enum(["text", "json_schema"]),
            name: z.string().optional(),
            schema: z.record(z.string(), z.unknown()).optional(),
            strict: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    stream: z.boolean().default(false),
    metadata: z.record(z.string(), z.string()).default({}),
    max_output_tokens: z.number().int().positive().max(128_000).optional(),
  })
  .strict();
export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

export const MODEL_CATALOG = [
  {
    alias: "luna",
    id: "gpt-5.6-luna",
    provider: "codex",
    purpose: "Bounded, high-throughput tasks",
  },
  {
    alias: "terra",
    id: "gpt-5.6-terra",
    provider: "codex",
    purpose: "Daily coding, integration, and review",
  },
  {
    alias: "sol",
    id: "gpt-5.6-sol",
    provider: "codex",
    purpose: "Ambiguous, high-risk planning and adjudication",
  },
] as const;
