import { z } from "zod";

export const ChatGptWebModeSchema = z.enum(["chat", "search", "deep_research"]);

export const BridgeInvocationSchema = z.object({
  jobId: z.string().uuid(),
  objective: z.string().min(1).max(100_000),
  model: z.string().min(1).max(128),
  mode: ChatGptWebModeSchema,
  conversationMode: z.literal("temporary_per_request"),
  temporaryChat: z.boolean(),
  personalized: z.literal(false),
  requireSources: z.boolean(),
  deadlineMs: z.number().int().min(1_000).max(3_600_000),
  deadlineAt: z.number().int().positive(),
  modelLabel: z.string().min(1).max(256).nullable().optional(),
  documentToken: z.string().uuid().nullable().optional(),
  diagnostic: z.boolean().default(false),
  attempt: z.number().int().min(1).max(2).default(1),
});
export type BridgeInvocation = z.infer<typeof BridgeInvocationSchema>;

export const BrowserModelSchema = z.object({
  id: z.string().max(128).default(""),
  displayName: z.string().min(1).max(256),
  available: z.boolean(),
});
export type BrowserModel = z.infer<typeof BrowserModelSchema>;

const BrowserControlSchema = z.object({
  tag: z.string().max(32),
  testId: z.string().max(128).nullable(),
  ariaLabel: z.string().max(256).nullable(),
  role: z.string().max(64).nullable(),
  buttonType: z.string().max(32).nullable(),
  disabled: z.boolean(),
});

export const BrowserControlDiagnosticsSchema = z.object({
  composerFound: z.boolean(),
  temporaryChatEnabled: z.boolean(),
  temporaryChatPersonalized: z.boolean().nullable().default(null),
  modelControlFound: z.boolean(),
  modelControl: BrowserControlSchema.nullable().default(null),
  modelControlText: z.string().max(64).nullable().default(null),
  modelControlPoint: z
    .object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() })
    .nullable()
    .default(null),
  toolsControlFound: z.boolean(),
  selectedSend: BrowserControlSchema.nullable(),
  sameRowControls: z.array(BrowserControlSchema).max(16),
  pageKind: z.enum(["home", "conversation", "other"]),
  surface: z.enum(["chat", "work", "unknown"]),
  assistantTurnCount: z.number().int().nonnegative(),
  blankAssistantTurnCount: z.number().int().nonnegative(),
  latestAssistantHasText: z.boolean(),
  generationActive: z.boolean(),
  userTurnCount: z.number().int().nonnegative().default(0),
  latestUserTextLength: z.number().int().nonnegative().default(0),
  expectedUserTextLength: z.number().int().nonnegative().nullable().default(null),
  latestUserMatchesObjective: z.boolean().nullable().default(null),
  composerTextLength: z.number().int().nonnegative().default(0),
  documentToken: z.string().uuid().nullable().default(null),
  freshConversation: z.boolean().default(false),
  terminalActionCount: z.number().int().nonnegative().default(0),
  terminalActions: z.array(BrowserControlSchema).max(16).default([]),
  visibleErrorCount: z.number().int().nonnegative().default(0),
  visibleErrorKinds: z
    .array(z.enum(["continue_generating", "retry", "generation_error", "other"]))
    .max(16)
    .default([]),
  latestAssistant: z
    .object({
      textContentLength: z.number().int().nonnegative(),
      innerTextLength: z.number().int().nonnegative(),
      accessibleNameLength: z.number().int().nonnegative(),
      containerInnerTextLength: z.number().int().nonnegative().default(0),
      containerMarkdownLength: z.number().int().nonnegative().default(0),
      childElementCount: z.number().int().nonnegative(),
      width: z.number().nonnegative(),
      height: z.number().nonnegative(),
      visible: z.boolean(),
      opacity: z.string().max(32),
    })
    .nullable()
    .default(null),
});
export type BrowserControlDiagnostics = z.infer<typeof BrowserControlDiagnosticsSchema>;

export const BrowserPageFailureCodeSchema = z.enum([
  "chatgpt_login_required",
  "chatgpt_verification_required",
  "chatgpt_rate_limited",
]);
export type BrowserPageFailureCode = z.infer<typeof BrowserPageFailureCodeSchema>;

export const BrowserSlotStateSchema = z.enum([
  "starting",
  "idle",
  "preparing",
  "ready",
  "submitted",
  "generating",
  "completed",
  "quarantined",
]);

export const BrowserSlotSchema = z.object({
  slotId: z.string().uuid(),
  state: BrowserSlotStateSchema,
  documentToken: z.string().uuid().nullable(),
  submitted: z.boolean(),
  quarantinedUntil: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type BrowserSlot = z.infer<typeof BrowserSlotSchema>;

export const ExtensionHelloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.literal(1),
  pageReady: z.boolean(),
  authenticated: z.boolean(),
  models: z.array(BrowserModelSchema).max(64),
  activeTabs: z.number().int().nonnegative(),
  slots: z.array(BrowserSlotSchema).max(4).default([]),
  quarantinedTabs: z.number().int().nonnegative().default(0),
  adapterVersion: z.string().max(64).default("dom-bridge-v2"),
  diagnostics: BrowserControlDiagnosticsSchema.nullable().optional(),
  failureCode: BrowserPageFailureCodeSchema.nullable().optional(),
});

export const ExtensionProgressSchema = z.object({
  type: z.literal("progress"),
  jobId: z.string().uuid(),
  phase: z.enum([
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
  ]),
  diagnostics: BrowserControlDiagnosticsSchema.nullable().optional(),
});

export const ExtensionCompletedSchema = z.object({
  type: z.literal("completed"),
  jobId: z.string().uuid(),
  outputText: z.string().max(1_000_000),
  sources: z.array(z.string().url()).max(256),
  conversationUrl: z.string().url().nullable(),
});

export const ExtensionFailedSchema = z.object({
  type: z.literal("failed"),
  jobId: z.string().uuid(),
  code: z.enum([
    "chatgpt_login_required",
    "chatgpt_verification_required",
    "chatgpt_ui_changed",
    "chatgpt_rate_limited",
    "chatgpt_timeout",
    "chatgpt_delivery_uncertain",
    "chatgpt_output_incomplete",
    "chatgpt_output_incomplete_blank",
    "chatgpt_page_not_ready",
    "chatgpt_page_generation_blank",
    "chatgpt_page_rendering_failed",
    "chatgpt_output_selector_changed",
    "chatgpt_clarification_required",
    "chatgpt_browser_unavailable",
  ]),
  message: z.string().max(500),
  diagnostics: BrowserControlDiagnosticsSchema.nullable().optional(),
});

export const ExtensionModelsSchema = z.object({
  type: z.literal("models"),
  pageReady: z.boolean(),
  authenticated: z.boolean(),
  models: z.array(BrowserModelSchema).max(64),
  activeTabs: z.number().int().nonnegative(),
  slots: z.array(BrowserSlotSchema).max(4).default([]),
  quarantinedTabs: z.number().int().nonnegative().default(0),
  adapterVersion: z.string().max(64).default("dom-bridge-v2"),
  diagnostics: BrowserControlDiagnosticsSchema.nullable().optional(),
  failureCode: BrowserPageFailureCodeSchema.nullable().optional(),
});

export const ExtensionKeepaliveSchema = z.object({
  type: z.literal("keepalive"),
});

export const ExtensionNativeClickRequestSchema = z.object({
  type: z.literal("native_click_request"),
  jobId: z.string().uuid(),
  action: z.enum([
    "tools_menu",
    "mode_option",
    "temporary_chat",
    "temporary_chat_non_personalized",
    "send_prompt",
  ]),
  x: z.number().int().min(0).max(1_439),
  y: z.number().int().min(0).max(899),
});

export const ExtensionNativeInputRequestSchema = z.object({
  type: z.literal("native_input_request"),
  jobId: z.string().uuid(),
  action: z.enum(["paste_prompt", "clear_clipboard"]),
  x: z.number().int().min(0).max(1_439).nullable().default(null),
  y: z.number().int().min(0).max(899).nullable().default(null),
  text: z.string().max(100_000).nullable().default(null),
});

export const ExtensionNativeResetRequestSchema = z.object({
  type: z.literal("native_reset_request"),
  requestId: z.string().uuid(),
  x: z.number().int().min(0).max(1_439),
  y: z.number().int().min(0).max(899),
});

export const ExtensionMessageSchema = z.discriminatedUnion("type", [
  ExtensionHelloSchema,
  ExtensionProgressSchema,
  ExtensionCompletedSchema,
  ExtensionFailedSchema,
  ExtensionModelsSchema,
  ExtensionKeepaliveSchema,
  ExtensionNativeClickRequestSchema,
  ExtensionNativeInputRequestSchema,
  ExtensionNativeResetRequestSchema,
]);
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;

export type ControllerMessage =
  | { type: "invoke"; invocation: BridgeInvocation }
  | { type: "cancel"; jobId: string }
  | { type: "probe"; discoverModels?: boolean }
  | { type: "native_reset_result"; requestId: string; ok: boolean }
  | { type: "configure" };
