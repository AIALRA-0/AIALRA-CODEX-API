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

export const ReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const DataClassificationSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
export type DataClassification = z.infer<typeof DataClassificationSchema>;

export const PermissionPresetSchema = z.enum(["restricted", "confirm", "full"]);
export type PermissionPreset = z.infer<typeof PermissionPresetSchema>;

export const SessionModeSchema = z.enum(["ephemeral", "persistent"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const ExecutionChannelSchema = z.enum(["codex", "chatgpt_web"]);
export type ExecutionChannel = z.infer<typeof ExecutionChannelSchema>;

export const ChatGptWebModeSchema = z.enum(["chat", "search", "deep_research"]);
export type ChatGptWebMode = z.infer<typeof ChatGptWebModeSchema>;

export const ChatGptWebConversationModeSchema = z.literal("temporary_per_request");
export type ChatGptWebConversationMode = z.infer<typeof ChatGptWebConversationModeSchema>;

export const ChatGptWebOptionsSchema = z
  .object({
    mode: ChatGptWebModeSchema.default("chat"),
    conversationMode: ChatGptWebConversationModeSchema.default("temporary_per_request"),
    temporaryChat: z.boolean().default(true),
    personalized: z.literal(false).default(false),
    requireSources: z.boolean().default(false),
  })
  .strict();
export type ChatGptWebOptions = z.infer<typeof ChatGptWebOptionsSchema>;

export const DEFAULT_SESSION_THREAD_TTL_MS = 86_400_000;

export function sessionThreadTtlMs(): number {
  const raw =
    typeof process !== "undefined"
      ? Number(process.env.SESSION_THREAD_TTL_MS ?? DEFAULT_SESSION_THREAD_TTL_MS)
      : DEFAULT_SESSION_THREAD_TTL_MS;
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_SESSION_THREAD_TTL_MS;
}

export const ExecutionPolicySchema = z
  .object({
    defaultPreset: PermissionPresetSchema.default("restricted"),
    allowedPresets: z.array(PermissionPresetSchema).min(1).max(3).default(["restricted"]),
  })
  .superRefine((value, context) => {
    if (new Set(value.allowedPresets).size !== value.allowedPresets.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedPresets"],
        message: "Permission presets must be unique.",
      });
    }
    if (!value.allowedPresets.includes(value.defaultPreset)) {
      context.addIssue({
        code: "custom",
        path: ["defaultPreset"],
        message: "The default permission preset must be allowed.",
      });
    }
  });
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

export const PermissionProfileSchema = z.object({
  preset: PermissionPresetSchema.optional(),
  filesystem: z.enum(["none", "read", "write"]).default("read"),
  network: z.enum(["none", "allowlist", "all"]).default("none"),
  allowedHosts: z.array(z.string().min(1)).max(32).default([]),
  requireApprovalForWrites: z.boolean().default(true),
  requireApprovalForExternalActions: z.boolean().default(true),
});
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

export function permissionProfileForPreset(preset: PermissionPreset): PermissionProfile {
  if (preset === "restricted") {
    return {
      preset,
      filesystem: "read",
      network: "none",
      allowedHosts: [],
      requireApprovalForWrites: false,
      requireApprovalForExternalActions: false,
    };
  }
  const confirmationRequired = preset === "confirm";
  return {
    preset,
    filesystem: "write",
    network: "all",
    allowedHosts: [],
    requireApprovalForWrites: confirmationRequired,
    requireApprovalForExternalActions: confirmationRequired,
  };
}

export const TaskBudgetSchema = z.object({
  maxCodexCredits: z.number().positive().optional(),
  maxOutputTokens: z.number().int().positive().max(128_000).default(8_192),
  maxAttempts: z.number().int().min(1).max(2).default(2),
});
export type TaskBudget = z.infer<typeof TaskBudgetSchema>;

export const ValidationCheckSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("equals"),
    expected: z.string().max(100_000),
    trim: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("contains"),
    expected: z.string().min(1).max(100_000),
  }),
]);
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;

export function parseLegacyValidationCheck(
  value: string,
  allowHistoricalSentence = false,
): ValidationCheck | null {
  if (value.startsWith("equals:")) {
    return { type: "equals", expected: value.slice("equals:".length), trim: true };
  }
  if (value.startsWith("contains:")) {
    const expected = value.slice("contains:".length);
    return expected ? { type: "contains", expected } : null;
  }
  if (allowHistoricalSentence) {
    const match = /^Output equals\s+(.+)$/i.exec(value.trim());
    if (match?.[1]) {
      return { type: "equals", expected: match[1], trim: true };
    }
  }
  return null;
}

export const ValidationContractSchema = z.object({
  responseSchema: z.record(z.string(), z.unknown()).optional(),
  checks: z.array(ValidationCheckSchema).max(32).default([]),
  acceptanceTests: z.array(z.string().min(1)).max(32).default([]),
});
export type ValidationContract = z.infer<typeof ValidationContractSchema>;

export const TaskContractSchema = z
  .object({
    objective: z.string().min(1).max(100_000),
    taskKind: z
      .enum(["bounded", "coding", "review", "planning", "batch", "general"])
      .default("general"),
    requiredContext: z.array(z.string()).max(128).default([]),
    constraints: z.array(z.string()).max(128).default([]),
    expectedOutput: z.string().max(20_000).default("Return the completed result."),
    validation: ValidationContractSchema.default({ checks: [], acceptanceTests: [] }),
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
    sessionMode: SessionModeSchema.default("ephemeral"),
    executionChannel: ExecutionChannelSchema.default("codex"),
    chatgptWeb: ChatGptWebOptionsSchema.optional(),
    model: ModelSelectionSchema.default("auto"),
    effort: ReasoningEffortSchema.default("medium"),
    replayable: z.boolean().default(true),
    ambiguity: z.number().int().min(0).max(4).default(1),
    risk: z.number().int().min(0).max(4).default(1),
  })
  .superRefine((value, context) => {
    if (value.executionChannel === "chatgpt_web" && !value.chatgptWeb) {
      context.addIssue({
        code: "custom",
        path: ["chatgptWeb"],
        message: "chatgptWeb options are required for the ChatGPT web channel.",
      });
    }
    if (value.executionChannel === "chatgpt_web" && value.sessionMode !== "ephemeral") {
      context.addIssue({
        code: "custom",
        path: ["sessionMode"],
        message: "The ChatGPT web channel does not support resumable Router sessions.",
      });
    }
    if (value.executionChannel === "chatgpt_web" && value.sessionKey) {
      context.addIssue({
        code: "custom",
        path: ["sessionKey"],
        message: "The ChatGPT web channel does not support resumable Router sessions.",
      });
    }
    if (value.executionChannel === "chatgpt_web" && value.chatgptWeb?.temporaryChat === false) {
      context.addIssue({
        code: "custom",
        path: ["chatgptWeb", "temporaryChat"],
        message: "The ChatGPT web channel requires a new non-personalized Temporary Chat.",
      });
    }
  });
export type TaskContract = z.infer<typeof TaskContractSchema>;

export const CreateJobRequestSchema = z.object({
  task: TaskContractSchema,
  metadata: z.record(z.string(), z.string().max(2_000)).default({}),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;
export type CreateJobRequestInput = z.input<typeof CreateJobRequestSchema>;

export const JobStatusSchema = z.enum([
  "accepted",
  "awaiting_approval",
  "queued",
  "running",
  "validating",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const RouteDecisionSchema = z.object({
  provider: ExecutionChannelSchema,
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
  measurementStatus: z.enum(["measured", "unavailable"]).optional(),
  subscriptionChannel: z.enum(["codex", "chatgpt_pro_web"]).optional(),
  sourceCount: z.number().int().nonnegative().nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  attemptCount: z.number().int().nonnegative().optional(),
  retryCount: z.number().int().nonnegative().optional(),
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
  provider: ExecutionChannelSchema.optional(),
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
  streamingMode: z.enum(["delta", "final_only"]).optional(),
  discoveredAt: z.string().datetime(),
});
export type RuntimeModel = z.infer<typeof RuntimeModelSchema>;

export const ChatGptWebStatusSchema = z.object({
  configuredEnabled: z.boolean(),
  effectiveConcurrency: z.number().int().min(0).max(4),
  maximumConcurrency: z.number().int().min(1).max(4),
  activeTabs: z.number().int().nonnegative(),
  queuedJobs: z.number().int().nonnegative(),
  sandboxVerified: z.boolean(),
  extensionConnected: z.boolean(),
  pageReady: z.boolean(),
  authenticated: z.boolean(),
  circuitState: z.enum(["closed", "cooldown", "open", "qualification_required"]),
  circuitReason: z.string().max(128).nullable(),
  cooldownUntil: z.string().datetime().nullable(),
  rateLimitState: z.enum(["clear", "cooldown", "recovery_probe", "observation"]).default("clear"),
  retryAfter: z.number().int().nonnegative().nullable().default(null),
  lastRateLimitAt: z.string().datetime().nullable().default(null),
  consecutiveRateLimits: z.number().int().nonnegative().default(0),
  conversationMode: ChatGptWebConversationModeSchema.default("temporary_per_request"),
  temporaryChatVerified: z.boolean().default(false),
  lastRecoveryProbeAt: z.string().datetime().nullable().default(null),
  lastRecoveryProbePassed: z.boolean().nullable().default(null),
  lastSubmissionAt: z.string().datetime().nullable().default(null),
  successesAtCurrentLevel: z.number().int().nonnegative(),
  attemptsAtCurrentLevel: z.number().int().nonnegative(),
  severeErrorsAtCurrentLevel: z.number().int().nonnegative(),
  lastQualifiedAt: z.string().datetime().nullable(),
  lastQualificationPassed: z.boolean().nullable(),
  lastQualificationSucceeded: z.number().int().min(0).max(10).nullable(),
  adapterVersion: z.string().max(64).default("dom-bridge-v1"),
  phase: z
    .enum([
      "idle",
      "preparing",
      "input_verified",
      "submitted",
      "generating",
      "completed",
      "failed",
      "resetting",
    ])
    .default("idle"),
  activeJobId: z.string().uuid().nullable().default(null),
  activeAttempt: z.number().int().min(1).max(2).nullable().default(null),
  lastHeartbeatAt: z.string().datetime().nullable().default(null),
  lastFailureCode: z.string().max(128).nullable().default(null),
  lastResetAt: z.string().datetime().nullable().default(null),
  quarantinedTabs: z.number().int().nonnegative().default(0),
  slots: z
    .array(
      z.object({
        slotId: z.string().uuid(),
        state: z.enum([
          "starting",
          "idle",
          "preparing",
          "ready",
          "submitted",
          "generating",
          "completed",
          "quarantined",
        ]),
        submitted: z.boolean(),
        quarantinedUntil: z.string().datetime().nullable(),
        updatedAt: z.string().datetime(),
      }),
    )
    .max(4)
    .default([]),
  lastQualificationRunId: z.string().uuid().nullable().default(null),
  updatedAt: z.string().datetime(),
});
export type ChatGptWebStatus = z.infer<typeof ChatGptWebStatusSchema>;

export const ChatGptWebQualificationSuiteSchema = z.enum([
  "readiness",
  "single_probe",
  "chat_3",
  "chat_10",
  "deep_2",
  "full_10",
]);
export type ChatGptWebQualificationSuite = z.infer<typeof ChatGptWebQualificationSuiteSchema>;

export const ChatGptWebFailurePhaseSchema = z.enum([
  "opening",
  "configuring",
  "temporary_chat_verified",
  "mode_selected",
  "input_ready",
  "submitted",
  "user_echo_verified",
  "generating",
  "stabilizing",
  "resetting",
]);
export type ChatGptWebFailurePhase = z.infer<typeof ChatGptWebFailurePhaseSchema>;

export const ChatGptWebDiagnosticSummarySchema = z.object({
  pageKind: z.enum(["home", "conversation", "other"]),
  userTurnCount: z.number().int().nonnegative(),
  assistantTurnCount: z.number().int().nonnegative(),
  latestUserMatchesObjective: z.boolean().nullable(),
  generationActive: z.boolean(),
  latestAssistantHasText: z.boolean(),
  visibleErrorKinds: z
    .array(z.enum(["continue_generating", "retry", "generation_error", "other"]))
    .max(16),
  temporaryChatVerified: z.boolean(),
});
export type ChatGptWebDiagnosticSummary = z.infer<typeof ChatGptWebDiagnosticSummarySchema>;

export const ChatGptWebQualificationItemSchema = z.object({
  index: z.number().int().min(1).max(10),
  name: z.string().min(1).max(64),
  mode: ChatGptWebModeSchema,
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  durationMs: z.number().int().nonnegative().nullable(),
  outputLength: z.number().int().nonnegative().nullable(),
  outputSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  sourceCount: z.number().int().nonnegative().nullable(),
  errorCode: z.string().max(128).nullable(),
  submittedCount: z.number().int().nonnegative(),
  recoveryCount: z.number().int().nonnegative().default(0),
  ownershipMatched: z.boolean().nullable(),
  temporaryChatVerified: z.boolean().default(false),
  failurePhase: ChatGptWebFailurePhaseSchema.nullable().optional(),
  diagnosticSummary: ChatGptWebDiagnosticSummarySchema.nullable().optional(),
});
export type ChatGptWebQualificationItem = z.infer<typeof ChatGptWebQualificationItemSchema>;

export const ChatGptWebQualificationRunSchema = z.object({
  id: z.string().uuid(),
  suite: ChatGptWebQualificationSuiteSchema,
  status: z.enum(["accepted", "running", "succeeded", "failed", "cancelled"]),
  total: z.number().int().min(0).max(10),
  completed: z.number().int().min(0).max(10),
  succeeded: z.number().int().min(0).max(10),
  failed: z.number().int().min(0).max(10),
  items: z.array(ChatGptWebQualificationItemSchema).max(10),
  errorCode: z.string().max(128).nullable(),
  createdBy: z.string().min(1).max(256),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type ChatGptWebQualificationRun = z.infer<typeof ChatGptWebQualificationRunSchema>;

export const ModelCatalogSnapshotSchema = z.object({
  models: z.array(RuntimeModelSchema.omit({ enabled: true })),
  fetchedAt: z.string().datetime(),
  source: z.enum(["app-server", "chatgpt-web", "combined", "unavailable"]),
});
export type ModelCatalogSnapshot = z.infer<typeof ModelCatalogSnapshotSchema>;

export const SessionThreadSchema = z.object({
  sessionKey: z.string().min(1).max(256),
  callerId: z.string().min(1),
  model: z.string().min(1),
  effort: ReasoningEffortSchema,
  turnCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type SessionThread = z.infer<typeof SessionThreadSchema>;

export const SessionAialraExtensionSchema = z
  .object({
    permission_preset: PermissionPresetSchema.optional(),
    session_key: z.string().min(1).max(256).optional(),
    session_mode: SessionModeSchema.optional(),
    deadline_ms: z.number().int().min(1_000).max(3_600_000).optional(),
    execution_channel: ExecutionChannelSchema.optional(),
    chatgpt_mode: ChatGptWebModeSchema.optional(),
    conversation_mode: ChatGptWebConversationModeSchema.optional(),
    temporary_chat: z.boolean().optional(),
    require_sources: z.boolean().optional(),
  })
  .strict();

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
    aialra: SessionAialraExtensionSchema.optional(),
  })
  .strict();
export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

export const ChatCompletionMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.string().max(100_000),
  name: z.string().max(64).optional(),
});
export type ChatCompletionMessage = z.infer<typeof ChatCompletionMessageSchema>;

export const ChatCompletionResponseFormatSchema = z.union([
  z.object({ type: z.literal("text") }).strict(),
  z.object({ type: z.literal("json_object") }).strict(),
  z
    .object({
      type: z.literal("json_schema"),
      json_schema: z
        .object({
          name: z.string().max(64).optional(),
          schema: z.record(z.string(), z.unknown()),
          strict: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const ChatCompletionsRequestSchema = z
  .object({
    model: ModelSelectionSchema.default("auto"),
    messages: z.array(ChatCompletionMessageSchema).min(1).max(256),
    stream: z.boolean().default(false),
    stream_options: z
      .object({ include_usage: z.boolean().default(false) })
      .strict()
      .optional(),
    max_tokens: z.number().int().positive().max(128_000).optional(),
    max_completion_tokens: z.number().int().positive().max(128_000).optional(),
    response_format: ChatCompletionResponseFormatSchema.optional(),
    reasoning_effort: ReasoningEffortSchema.optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    aialra: SessionAialraExtensionSchema.optional(),
  })
  .strict();
export type ChatCompletionsRequest = z.infer<typeof ChatCompletionsRequestSchema>;
export type ChatCompletionsRequestInput = z.input<typeof ChatCompletionsRequestSchema>;

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: { role: "assistant"; content: string };
      finish_reason: "stop" | "length";
    },
  ];
  usage?: ChatCompletionUsage;
  aialra?: {
    job_id: string;
    session_key: string | null;
    measurement_status?: "measured" | "unavailable";
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      delta: { role?: "assistant"; content?: string };
      finish_reason: "stop" | "length" | null;
    },
  ];
  usage?: ChatCompletionUsage | null;
}

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
