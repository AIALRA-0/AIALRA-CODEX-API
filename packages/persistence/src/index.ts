import { randomUUID } from "node:crypto";

import {
  type ExecutionPolicy,
  ChatGptWebQualificationRunSchema,
  type ChatGptWebQualificationRun,
  ChatGptWebStatusSchema,
  type ChatGptWebStatus,
  parseLegacyValidationCheck,
  TaskContractSchema,
  UsageLedgerSchema,
  type Job,
  type JobEvent,
  JobStatusSchema,
  type JobStatus,
  type ModelCatalogSnapshot,
  type QuotaSnapshot,
  type SessionThread,
  type ValidationResult,
} from "@aialra/contracts";
import { decryptRecord, encryptRecord, isEncryptedRecord } from "@aialra/security";
import pg from "pg";

const { Pool } = pg;

export function defaultChatGptWebStatus(now = new Date()): ChatGptWebStatus {
  return {
    configuredEnabled: false,
    effectiveConcurrency: 0,
    maximumConcurrency: 1,
    activeTabs: 0,
    queuedJobs: 0,
    sandboxVerified: false,
    extensionConnected: false,
    pageReady: false,
    authenticated: false,
    circuitState: "qualification_required",
    circuitReason: "qualification_not_completed",
    cooldownUntil: null,
    rateLimitState: "clear",
    retryAfter: null,
    lastRateLimitAt: null,
    consecutiveRateLimits: 0,
    conversationMode: "temporary_per_request",
    temporaryChatVerified: false,
    lastRecoveryProbeAt: null,
    lastRecoveryProbePassed: null,
    lastSubmissionAt: null,
    successesAtCurrentLevel: 0,
    attemptsAtCurrentLevel: 0,
    severeErrorsAtCurrentLevel: 0,
    lastQualifiedAt: null,
    lastQualificationPassed: null,
    lastQualificationSucceeded: null,
    adapterVersion: "single-page-v1",
    phase: "idle",
    activeJobId: null,
    activeAttempt: null,
    lastHeartbeatAt: null,
    lastFailureCode: null,
    lastResetAt: null,
    quarantinedTabs: 0,
    slots: [],
    lastQualificationRunId: null,
    updatedAt: now.toISOString(),
  };
}

export function parseChatGptWebStatus(value: unknown, now = new Date()): ChatGptWebStatus {
  const stored = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return ChatGptWebStatusSchema.parse({
    ...defaultChatGptWebStatus(now),
    ...stored,
  });
}

function classifyLegacyReview(
  taskValue: unknown,
  output: unknown,
  storedValidation: ValidationResult | null,
  errorCode: string | null,
): {
  status: "succeeded" | "failed" | "cancelled";
  validation: ValidationResult | null;
  errorCode: string | null;
  errorMessage: string | null;
} {
  if (errorCode === "approval_required" || errorCode === "approval_denied") {
    return {
      status: "cancelled",
      validation: storedValidation,
      errorCode: "approval_denied",
      errorMessage: "The execution permission was not granted.",
    };
  }
  if (output === null) {
    return {
      status: "failed",
      validation: storedValidation,
      errorCode: errorCode ?? "legacy_review_failed",
      errorMessage: "The historical call did not produce an output that could be validated.",
    };
  }
  const task = TaskContractSchema.parse(taskValue);
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const messages: string[] = [];
  let passed = !task.validation.responseSchema || storedValidation?.schemaPassed === true;
  let testsPassed = 0;
  let testsFailed = 0;
  for (const rule of task.validation.acceptanceTests) {
    const check = parseLegacyValidationCheck(rule, true);
    const checkPassed =
      check?.type === "equals"
        ? (check.trim ? text.trim() : text) ===
          (check.trim ? check.expected.trim() : check.expected)
        : check?.type === "contains"
          ? text.includes(check.expected)
          : false;
    if (checkPassed) testsPassed += 1;
    else {
      testsFailed += 1;
      messages.push(check ? `legacy_validation_failed:${rule}` : `invalid_validation_rule:${rule}`);
    }
  }
  for (const check of task.validation.checks) {
    const checkPassed =
      check.type === "equals"
        ? (check.trim ? text.trim() : text) ===
          (check.trim ? check.expected.trim() : check.expected)
        : text.includes(check.expected);
    if (checkPassed) testsPassed += 1;
    else {
      testsFailed += 1;
      messages.push(`${check.type}_failed`);
    }
  }
  passed = passed && testsFailed === 0;
  const validation: ValidationResult = {
    passed,
    schemaPassed: task.validation.responseSchema ? (storedValidation?.schemaPassed ?? false) : null,
    testsPassed,
    testsFailed,
    messages,
  };
  return passed
    ? { status: "succeeded", validation, errorCode: null, errorMessage: null }
    : {
        status: "failed",
        validation,
        errorCode: "validation_failed",
        errorMessage: "The historical output did not satisfy its declared validation rules.",
      };
}

const HISTORICAL_STATUS_BY_AUDIT_ACTION: Readonly<Record<string, JobStatus>> = {
  "job.created": "accepted",
  "job.awaiting_approval": "awaiting_approval",
  "job.queued": "queued",
  "job.queued_after_approval": "queued",
  "job.approval_denied": "cancelled",
  "job.cancelled": "cancelled",
  "worker.running": "running",
  "worker.validating": "validating",
  "worker.succeeded": "succeeded",
  "worker.failed": "failed",
  "worker.provider_unavailable": "failed",
  "worker.session_expired": "failed",
  "worker.expired": "expired",
};

export type HistoricalAuditStatusRecord = {
  action: string;
  createdAt: string;
};

export type HistoricalJobEventRecovery = {
  events: Array<{
    status: JobStatus;
    createdAt: string;
    data: Record<string, unknown>;
    source: "audit_events" | "jobs.status";
  }>;
  auditDerivedEvents: number;
  currentStatusEvents: number;
  ignoredAuditActions: number;
  hasUnresolvedHistory: boolean;
};

export function reconstructHistoricalJobEventData(
  currentStatus: JobStatus,
  updatedAt: string,
  auditEvents: readonly HistoricalAuditStatusRecord[],
): HistoricalJobEventRecovery {
  const events: HistoricalJobEventRecovery["events"] = [];
  let ignoredAuditActions = 0;
  const orderedAudits = [...auditEvents].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  for (const audit of orderedAudits) {
    const status = HISTORICAL_STATUS_BY_AUDIT_ACTION[audit.action];
    if (!status) {
      ignoredAuditActions += 1;
      continue;
    }
    events.push({
      status,
      createdAt: audit.createdAt,
      data: {
        status,
        historicalRecovery: true,
        reconstructedFrom: "audit_events",
        sourceAction: audit.action,
      },
      source: "audit_events",
    });
  }
  const currentStatusMatches = events.at(-1)?.status === currentStatus;
  if (!currentStatusMatches) {
    events.push({
      status: currentStatus,
      createdAt: updatedAt,
      data: {
        status: currentStatus,
        historicalRecovery: true,
        reconstructedFrom: "jobs.status",
      },
      source: "jobs.status",
    });
  }
  return {
    events,
    auditDerivedEvents: events.filter((event) => event.source === "audit_events").length,
    currentStatusEvents: events.filter((event) => event.source === "jobs.status").length,
    ignoredAuditActions,
    hasUnresolvedHistory: !currentStatusMatches || ignoredAuditActions > 0,
  };
}

export type HistoricalJobEventRecoveryReport = {
  version: 4;
  candidateJobs: number;
  insertedEvents: number;
  auditDerivedEvents: number;
  currentStatusEvents: number;
  jobsWithUnresolvedHistory: number;
  ignoredAuditActions: number;
};

export interface StoredApiKey {
  id: string;
  createdBy: string;
  name: string;
  prefix: string;
  digest: string;
  scopes: string[];
  executionPolicy: ExecutionPolicy;
  rateLimitPerMinute: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ApiKeyCreationResult {
  record: StoredApiKey;
  plaintext: string;
  replayed: boolean;
}

export type ApiKeyMetadata = Omit<StoredApiKey, "digest" | "createdBy">;

function apiKeyWithoutDigest(record: StoredApiKey): ApiKeyMetadata {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: record.scopes,
    executionPolicy: structuredClone(record.executionPolicy),
    rateLimitPerMinute: record.rateLimitPerMinute,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

export interface IdentityUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface StoredPasskey {
  id: string;
  userId: string;
  credentialId: string;
  publicKeyBase64: string;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
}

export interface AuthChallenge {
  id: string;
  userId: string;
  purpose: "registration" | "authentication";
  challenge: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface AuthSession {
  id: string;
  userId: string;
  digest: string;
  expiresAt: string;
  createdAt: string;
}

export interface RecoveryCodeRecord {
  id: string;
  userId: string;
  digest: string;
  createdAt: string;
  usedAt: string | null;
}

export interface AuditEvent {
  id: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DeletionReceipt {
  id: string;
  jobId: string;
  payloadDeletedAt: string;
  metadataDeleteAfter: string;
}

export interface ModelSetting {
  modelId: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface ModelSettingResult {
  setting: ModelSetting;
  replayed: boolean;
}

export interface JobRepository {
  create(job: Job): Promise<Job>;
  findById(id: string): Promise<Job | null>;
  findByIdempotency(callerId: string, key: string): Promise<Job | null>;
  list(limit?: number): Promise<Job[]>;
  update(id: string, patch: Partial<Job>): Promise<Job>;
  transitionJob(id: string, patch: Partial<Job>, audit: AuditEvent): Promise<Job>;
  appendEvent(
    jobId: string,
    type: JobEvent["type"],
    data: Record<string, unknown>,
  ): Promise<JobEvent>;
  events(jobId: string, afterSequence?: number): Promise<JobEvent[]>;
  saveQuotaSnapshot(snapshot: QuotaSnapshot): Promise<void>;
  latestQuotaSnapshot(): Promise<QuotaSnapshot | null>;
  saveModelCatalog(snapshot: ModelCatalogSnapshot): Promise<void>;
  latestModelCatalog(): Promise<ModelCatalogSnapshot | null>;
  readChatGptWebStatus(): Promise<ChatGptWebStatus>;
  saveChatGptWebStatus(status: ChatGptWebStatus): Promise<void>;
  createChatGptWebQualificationRun(
    run: ChatGptWebQualificationRun,
  ): Promise<ChatGptWebQualificationRun>;
  findChatGptWebQualificationRun(id: string): Promise<ChatGptWebQualificationRun | null>;
  updateChatGptWebQualificationRun(
    id: string,
    patch: Partial<ChatGptWebQualificationRun>,
  ): Promise<ChatGptWebQualificationRun>;
  listChatGptWebQualificationRuns(limit?: number): Promise<ChatGptWebQualificationRun[]>;
  listModelSettings(): Promise<ModelSetting[]>;
  setModelEnabled(modelId: string, enabled: boolean, actorId: string): Promise<ModelSetting>;
  setModelEnabledIdempotent(
    modelId: string,
    enabled: boolean,
    actorId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<ModelSettingResult>;
  upsertSessionThread(thread: SessionThread): Promise<SessionThread>;
  findSessionThread(sessionKey: string): Promise<SessionThread | null>;
  listSessionThreads(actorId: string, isAdmin: boolean, limit?: number): Promise<SessionThread[]>;
  deleteExpiredSessionThreads(now: Date): Promise<number>;
  createApiKey(record: StoredApiKey): Promise<StoredApiKey>;
  createApiKeyIdempotent(
    actorId: string,
    idempotencyKey: string,
    requestHash: string,
    record: StoredApiKey,
    plaintext: string,
  ): Promise<ApiKeyCreationResult>;
  findApiKeyByPrefix(prefix: string): Promise<StoredApiKey | null>;
  findApiKeyById(id: string): Promise<StoredApiKey | null>;
  listApiKeys(): Promise<ApiKeyMetadata[]>;
  listApiKeysForActor(actorId: string, isAdmin: boolean): Promise<ApiKeyMetadata[]>;
  touchApiKey(id: string): Promise<void>;
  revokeApiKey(id: string): Promise<void>;
  apiKeyCount(): Promise<number>;
  activeAdminApiKeyCount(): Promise<number>;
  consumeRateLimit(subject: string, limit: number, now: Date): Promise<boolean>;
  createUser(user: IdentityUser): Promise<IdentityUser>;
  findUserByEmail(email: string): Promise<IdentityUser | null>;
  findUserById(id: string): Promise<IdentityUser | null>;
  userCount(): Promise<number>;
  createPasskey(passkey: StoredPasskey): Promise<void>;
  passkeysForUser(userId: string): Promise<StoredPasskey[]>;
  findPasskey(credentialId: string): Promise<StoredPasskey | null>;
  updatePasskeyCounter(id: string, counter: number): Promise<void>;
  createChallenge(challenge: AuthChallenge): Promise<void>;
  consumeChallenge(id: string): Promise<AuthChallenge | null>;
  createSession(session: AuthSession): Promise<void>;
  findSessionByDigest(digest: string): Promise<AuthSession | null>;
  deleteSessionByDigest(digest: string): Promise<boolean>;
  createRecoveryCodes(records: RecoveryCodeRecord[]): Promise<void>;
  consumeRecoveryCode(userId: string, digest: string): Promise<boolean>;
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(limit?: number): Promise<AuditEvent[]>;
  listDeletionReceipts(limit?: number): Promise<DeletionReceipt[]>;
  deleteExpiredPayloads(now: Date): Promise<number>;
  deleteExpiredMetadata(now: Date): Promise<number>;
}

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, Job>();
  private readonly eventMap = new Map<string, JobEvent[]>();
  private quotaSnapshot: QuotaSnapshot | null = null;
  private modelCatalog: ModelCatalogSnapshot | null = null;
  private chatGptWebStatus: ChatGptWebStatus = defaultChatGptWebStatus();
  private readonly chatGptWebQualificationRuns = new Map<string, ChatGptWebQualificationRun>();
  private readonly modelSettings = new Map<string, ModelSetting>(
    ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"].map((modelId) => [
      modelId,
      { modelId, enabled: true, updatedAt: new Date(0).toISOString(), updatedBy: "migration" },
    ]),
  );
  private readonly modelSettingRequests = new Map<
    string,
    { requestHash: string; setting: ModelSetting }
  >();
  private readonly sessionThreads = new Map<string, SessionThread>();
  private readonly apiKeys = new Map<string, StoredApiKey>();
  private readonly apiKeyRequests = new Map<
    string,
    { requestHash: string; record: StoredApiKey; plaintext: string }
  >();
  private readonly users = new Map<string, IdentityUser>();
  private readonly passkeys = new Map<string, StoredPasskey>();
  private readonly challenges = new Map<string, AuthChallenge>();
  private readonly sessions = new Map<string, AuthSession>();
  private readonly recoveryCodes = new Map<string, RecoveryCodeRecord>();
  private readonly auditEvents: AuditEvent[] = [];
  private readonly deletionReceipts = new Map<string, DeletionReceipt>();
  private readonly rateLimits = new Map<string, { minute: number; count: number }>();

  async create(job: Job): Promise<Job> {
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  async findById(id: string): Promise<Job | null> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  async findByIdempotency(callerId: string, key: string): Promise<Job | null> {
    const job = [...this.jobs.values()].find(
      (candidate) => candidate.callerId === callerId && candidate.idempotencyKey === key,
    );
    return job ? structuredClone(job) : null;
  }

  async list(limit = 100): Promise<Job[]> {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }

  async update(id: string, patch: Partial<Job>): Promise<Job> {
    const current = this.jobs.get(id);
    if (!current) {
      throw new Error("job_not_found");
    }

    const updated = { ...current, ...structuredClone(patch), updatedAt: new Date().toISOString() };
    this.jobs.set(id, updated);
    return structuredClone(updated);
  }

  async transitionJob(id: string, patch: Partial<Job>, audit: AuditEvent): Promise<Job> {
    if (!patch.status) throw new Error("job_status_required");
    const updated = await this.update(id, patch);
    await this.appendEvent(id, "status", { status: patch.status });
    await this.appendAudit(audit);
    return updated;
  }

  async appendEvent(
    jobId: string,
    type: JobEvent["type"],
    data: Record<string, unknown>,
  ): Promise<JobEvent> {
    const events = this.eventMap.get(jobId) ?? [];
    const event: JobEvent = {
      id: randomUUID(),
      jobId,
      sequence: events.length,
      type,
      data: structuredClone(data),
      createdAt: new Date().toISOString(),
    };
    events.push(event);
    this.eventMap.set(jobId, events);
    return structuredClone(event);
  }

  async events(jobId: string, afterSequence = -1): Promise<JobEvent[]> {
    return (this.eventMap.get(jobId) ?? [])
      .filter((event) => event.sequence > afterSequence)
      .map((event) => structuredClone(event));
  }

  async saveQuotaSnapshot(snapshot: QuotaSnapshot): Promise<void> {
    this.quotaSnapshot = structuredClone(snapshot);
  }

  async latestQuotaSnapshot(): Promise<QuotaSnapshot | null> {
    return this.quotaSnapshot ? structuredClone(this.quotaSnapshot) : null;
  }

  async saveModelCatalog(snapshot: ModelCatalogSnapshot): Promise<void> {
    this.modelCatalog = structuredClone(snapshot);
  }

  async latestModelCatalog(): Promise<ModelCatalogSnapshot | null> {
    return this.modelCatalog ? structuredClone(this.modelCatalog) : null;
  }

  async readChatGptWebStatus(): Promise<ChatGptWebStatus> {
    return structuredClone(this.chatGptWebStatus);
  }

  async saveChatGptWebStatus(status: ChatGptWebStatus): Promise<void> {
    this.chatGptWebStatus = parseChatGptWebStatus(structuredClone(status));
  }

  async createChatGptWebQualificationRun(
    run: ChatGptWebQualificationRun,
  ): Promise<ChatGptWebQualificationRun> {
    const parsed = ChatGptWebQualificationRunSchema.parse(structuredClone(run));
    this.chatGptWebQualificationRuns.set(parsed.id, parsed);
    return structuredClone(parsed);
  }

  async findChatGptWebQualificationRun(id: string): Promise<ChatGptWebQualificationRun | null> {
    const run = this.chatGptWebQualificationRuns.get(id);
    return run ? structuredClone(run) : null;
  }

  async updateChatGptWebQualificationRun(
    id: string,
    patch: Partial<ChatGptWebQualificationRun>,
  ): Promise<ChatGptWebQualificationRun> {
    const current = this.chatGptWebQualificationRuns.get(id);
    if (!current) throw new Error("chatgpt_web_qualification_not_found");
    const updated = ChatGptWebQualificationRunSchema.parse({
      ...current,
      ...structuredClone(patch),
      id,
      updatedAt: new Date().toISOString(),
    });
    this.chatGptWebQualificationRuns.set(id, updated);
    return structuredClone(updated);
  }

  async listChatGptWebQualificationRuns(limit = 20): Promise<ChatGptWebQualificationRun[]> {
    return [...this.chatGptWebQualificationRuns.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.min(limit, 100))
      .map((run) => structuredClone(run));
  }

  async listModelSettings(): Promise<ModelSetting[]> {
    return [...this.modelSettings.values()].map((setting) => structuredClone(setting));
  }

  async setModelEnabled(modelId: string, enabled: boolean, actorId: string): Promise<ModelSetting> {
    const stored = { modelId, enabled, updatedBy: actorId, updatedAt: new Date().toISOString() };
    this.modelSettings.set(modelId, stored);
    return structuredClone(stored);
  }

  async setModelEnabledIdempotent(
    modelId: string,
    enabled: boolean,
    actorId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<ModelSettingResult> {
    const key = `${actorId}:${idempotencyKey}`;
    const existing = this.modelSettingRequests.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error("idempotency_conflict");
      return { setting: structuredClone(existing.setting), replayed: true };
    }
    const setting = await this.setModelEnabled(modelId, enabled, actorId);
    this.modelSettingRequests.set(key, { requestHash, setting: structuredClone(setting) });
    return { setting, replayed: false };
  }

  async upsertSessionThread(thread: SessionThread): Promise<SessionThread> {
    this.sessionThreads.set(thread.sessionKey, structuredClone(thread));
    return structuredClone(thread);
  }

  async findSessionThread(sessionKey: string): Promise<SessionThread | null> {
    const thread = this.sessionThreads.get(sessionKey);
    return thread ? structuredClone(thread) : null;
  }

  async listSessionThreads(
    actorId: string,
    isAdmin: boolean,
    limit = 100,
  ): Promise<SessionThread[]> {
    return [...this.sessionThreads.values()]
      .filter((thread) => isAdmin || thread.callerId === actorId)
      .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
      .slice(0, limit)
      .map((thread) => structuredClone(thread));
  }

  async deleteExpiredSessionThreads(now: Date): Promise<number> {
    let deleted = 0;
    for (const [sessionKey, thread] of this.sessionThreads.entries()) {
      if (new Date(thread.expiresAt) <= now) {
        this.sessionThreads.delete(sessionKey);
        deleted += 1;
      }
    }
    return deleted;
  }

  async createApiKey(record: StoredApiKey): Promise<StoredApiKey> {
    this.apiKeys.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async createApiKeyIdempotent(
    actorId: string,
    idempotencyKey: string,
    requestHashValue: string,
    record: StoredApiKey,
    plaintext: string,
  ): Promise<ApiKeyCreationResult> {
    const requestKey = `${actorId}:${idempotencyKey}`;
    const existing = this.apiKeyRequests.get(requestKey);
    if (existing) {
      if (existing.requestHash !== requestHashValue) throw new Error("idempotency_conflict");
      return {
        record: structuredClone(existing.record),
        plaintext: existing.plaintext,
        replayed: true,
      };
    }
    this.apiKeys.set(record.id, structuredClone(record));
    this.apiKeyRequests.set(requestKey, {
      requestHash: requestHashValue,
      record: structuredClone(record),
      plaintext,
    });
    return { record: structuredClone(record), plaintext, replayed: false };
  }

  async findApiKeyByPrefix(prefix: string): Promise<StoredApiKey | null> {
    const record = [...this.apiKeys.values()].find((candidate) => candidate.prefix === prefix);
    return record ? structuredClone(record) : null;
  }

  async findApiKeyById(id: string): Promise<StoredApiKey | null> {
    const record = this.apiKeys.get(id);
    return record ? structuredClone(record) : null;
  }

  async listApiKeys(): Promise<ApiKeyMetadata[]> {
    return [...this.apiKeys.values()].map((record) => structuredClone(apiKeyWithoutDigest(record)));
  }

  async listApiKeysForActor(actorId: string, isAdmin: boolean): Promise<ApiKeyMetadata[]> {
    return [...this.apiKeys.values()]
      .filter((record) => isAdmin || record.createdBy === actorId)
      .map((record) => structuredClone(apiKeyWithoutDigest(record)));
  }

  async touchApiKey(id: string): Promise<void> {
    const record = this.apiKeys.get(id);
    if (record) {
      this.apiKeys.set(id, { ...record, lastUsedAt: new Date().toISOString() });
    }
  }

  async revokeApiKey(id: string): Promise<void> {
    const record = this.apiKeys.get(id);
    if (record) {
      this.apiKeys.set(id, { ...record, revokedAt: new Date().toISOString() });
    }
  }

  async apiKeyCount(): Promise<number> {
    return this.apiKeys.size;
  }

  async activeAdminApiKeyCount(): Promise<number> {
    return [...this.apiKeys.values()].filter(
      (record) => record.scopes.includes("admin") && !record.revokedAt,
    ).length;
  }

  async consumeRateLimit(subject: string, limit: number, now: Date): Promise<boolean> {
    const minute = Math.floor(now.getTime() / 60_000);
    const current = this.rateLimits.get(subject);
    const count = current?.minute === minute ? current.count + 1 : 1;
    this.rateLimits.set(subject, { minute, count });
    return count <= limit;
  }

  async createUser(user: IdentityUser): Promise<IdentityUser> {
    this.users.set(user.id, structuredClone(user));
    return structuredClone(user);
  }

  async findUserByEmail(email: string): Promise<IdentityUser | null> {
    const user = [...this.users.values()].find((candidate) => candidate.email === email);
    return user ? structuredClone(user) : null;
  }

  async findUserById(id: string): Promise<IdentityUser | null> {
    const user = this.users.get(id);
    return user ? structuredClone(user) : null;
  }

  async userCount(): Promise<number> {
    return this.users.size;
  }

  async createPasskey(passkey: StoredPasskey): Promise<void> {
    this.passkeys.set(passkey.id, structuredClone(passkey));
  }

  async passkeysForUser(userId: string): Promise<StoredPasskey[]> {
    return [...this.passkeys.values()]
      .filter((passkey) => passkey.userId === userId)
      .map((passkey) => structuredClone(passkey));
  }

  async findPasskey(credentialId: string): Promise<StoredPasskey | null> {
    const passkey = [...this.passkeys.values()].find(
      (candidate) => candidate.credentialId === credentialId,
    );
    return passkey ? structuredClone(passkey) : null;
  }

  async updatePasskeyCounter(id: string, counter: number): Promise<void> {
    const passkey = this.passkeys.get(id);
    if (passkey) {
      this.passkeys.set(id, { ...passkey, counter });
    }
  }

  async createChallenge(challenge: AuthChallenge): Promise<void> {
    this.challenges.set(challenge.id, structuredClone(challenge));
  }

  async consumeChallenge(id: string): Promise<AuthChallenge | null> {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.usedAt || new Date(challenge.expiresAt) <= new Date()) {
      return null;
    }
    this.challenges.set(id, { ...challenge, usedAt: new Date().toISOString() });
    return structuredClone(challenge);
  }

  async createSession(session: AuthSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async findSessionByDigest(digest: string): Promise<AuthSession | null> {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.digest === digest && new Date(candidate.expiresAt) > new Date(),
    );
    return session ? structuredClone(session) : null;
  }

  async deleteSessionByDigest(digest: string): Promise<boolean> {
    const session = [...this.sessions.values()].find((candidate) => candidate.digest === digest);
    if (!session) return false;
    return this.sessions.delete(session.id);
  }

  async createRecoveryCodes(records: RecoveryCodeRecord[]): Promise<void> {
    for (const record of records) {
      this.recoveryCodes.set(record.id, structuredClone(record));
    }
  }

  async consumeRecoveryCode(userId: string, digest: string): Promise<boolean> {
    const record = [...this.recoveryCodes.values()].find(
      (candidate) =>
        candidate.userId === userId && candidate.digest === digest && !candidate.usedAt,
    );
    if (!record) {
      return false;
    }
    this.recoveryCodes.set(record.id, { ...record, usedAt: new Date().toISOString() });
    return true;
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.auditEvents.push(structuredClone(event));
  }

  async listAudit(limit = 100): Promise<AuditEvent[]> {
    return this.auditEvents
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.min(limit, 500))
      .map((event) => structuredClone(event));
  }

  async listDeletionReceipts(limit = 100): Promise<DeletionReceipt[]> {
    return [...this.deletionReceipts.values()]
      .sort((left, right) => right.payloadDeletedAt.localeCompare(left.payloadDeletedAt))
      .slice(0, Math.min(limit, 500))
      .map((receipt) => structuredClone(receipt));
  }

  async deleteExpiredPayloads(now: Date): Promise<number> {
    let deleted = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (new Date(job.expiresAt) <= now && job.task.objective !== "[deleted]") {
        this.jobs.set(id, {
          ...job,
          task: { ...job.task, objective: "[deleted]", requiredContext: [], constraints: [] },
          output: null,
        });
        this.eventMap.delete(id);
        this.deletionReceipts.set(id, {
          id: randomUUID(),
          jobId: id,
          payloadDeletedAt: now.toISOString(),
          metadataDeleteAfter: new Date(
            new Date(job.createdAt).getTime() + 90 * 86_400_000,
          ).toISOString(),
        });
        deleted += 1;
      }
    }
    return deleted;
  }

  async deleteExpiredMetadata(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 90 * 86_400_000);
    let deleted = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (new Date(job.createdAt) <= cutoff) {
        this.jobs.delete(id);
        this.eventMap.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export const DATABASE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT,
  caller_id TEXT NOT NULL,
  task JSONB NOT NULL,
  route JSONB,
  output JSONB,
  error_code TEXT,
  error_message TEXT,
  usage JSONB NOT NULL,
  validation JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (caller_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs(expires_at);

CREATE TABLE IF NOT EXISTS job_events (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (job_id, sequence)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY,
  created_by TEXT NOT NULL DEFAULT 'legacy',
  name TEXT NOT NULL,
  prefix TEXT UNIQUE NOT NULL,
  digest TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  execution_default_preset TEXT NOT NULL DEFAULT 'restricted',
  execution_allowed_presets TEXT[] NOT NULL DEFAULT ARRAY['restricted']::TEXT[],
  rate_limit_per_minute INTEGER NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ
);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS execution_default_preset TEXT NOT NULL DEFAULT 'restricted';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS execution_allowed_presets TEXT[] NOT NULL DEFAULT ARRAY['restricted']::TEXT[];

CREATE TABLE IF NOT EXISTS api_key_requests (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  subject TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (subject, window_start)
);

CREATE TABLE IF NOT EXISTS quota_snapshots (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_current (
  provider TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS model_catalog_current (
  provider TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS chatgpt_web_status (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  status JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS chatgpt_web_qualification_runs (
  id UUID PRIMARY KEY,
  run JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chatgpt_web_qualification_runs_created_at
  ON chatgpt_web_qualification_runs(created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chatgpt_web_qualification_runs_one_active
  ON chatgpt_web_qualification_runs ((1))
  WHERE run->>'status' IN ('accepted', 'running');

CREATE TABLE IF NOT EXISTS model_settings (
  model_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_setting_requests (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key)
);

INSERT INTO model_settings (model_id, enabled, updated_at, updated_by) VALUES
  ('gpt-5.6-luna', TRUE, NOW(), 'migration'),
  ('gpt-5.6-terra', TRUE, NOW(), 'migration'),
  ('gpt-5.6-sol', TRUE, NOW(), 'migration')
ON CONFLICT (model_id) DO NOTHING;

-- session_threads stores only conversation governance metadata (no payload content),
-- so it stays plaintext like model_settings.
CREATE TABLE IF NOT EXISTS session_threads (
  session_key TEXT PRIMARY KEY,
  caller_id TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS session_threads_caller_idx ON session_threads (caller_id, last_used_at DESC);
CREATE INDEX IF NOT EXISTS session_threads_expiry_idx ON session_threads (expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS deletion_receipts (
  id UUID PRIMARY KEY,
  job_id UUID UNIQUE NOT NULL,
  payload_deleted_at TIMESTAMPTZ NOT NULL,
  metadata_delete_after TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS passkeys (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  credential_id TEXT UNIQUE NOT NULL,
  public_key_base64 TEXT NOT NULL,
  counter BIGINT NOT NULL,
  transports TEXT[] NOT NULL,
  device_type TEXT NOT NULL,
  backed_up BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  digest TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  digest TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
`;

export class PostgresJobRepository implements JobRepository {
  readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private readonly masterKeyBase64: string,
  ) {
    if (Buffer.from(masterKeyBase64, "base64").length !== 32) {
      throw new Error("payload_master_key_must_be_32_bytes");
    }
    this.pool = new Pool({ connectionString, max: 10 });
  }

  private encrypt(value: unknown, aad: string): unknown {
    return encryptRecord(value, this.masterKeyBase64, aad);
  }

  private decrypt<T>(value: unknown, aad: string): T {
    if (!isEncryptedRecord(value)) {
      throw new Error("unencrypted_database_payload_rejected");
    }
    return decryptRecord<T>(value, this.masterKeyBase64, aad);
  }

  private rowToJob(row: Record<string, any>): Job {
    return {
      id: row.id,
      status: row.status as JobStatus,
      requestHash: row.request_hash,
      idempotencyKey: row.idempotency_key,
      callerId: row.caller_id,
      task: this.decrypt(row.task, `job:${row.id}:task:v2`),
      route: row.route,
      output: row.output === null ? null : this.decrypt(row.output, `job:${row.id}:output:v2`),
      errorCode: row.error_code,
      errorMessage: row.error_message,
      usage: UsageLedgerSchema.parse(row.usage),
      validation: row.validation,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('aialra_model_router_migrate'))");
      await client.query(DATABASE_MIGRATION_SQL);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING",
      );
      const permissionPolicyMigration = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version=2",
      );
      if (!permissionPolicyMigration.rowCount) {
        await client.query(
          `UPDATE api_keys
           SET execution_default_preset='full',
               execution_allowed_presets=ARRAY['restricted','confirm','full']::TEXT[]
           WHERE 'admin'=ANY(scopes)`,
        );
        await client.query("INSERT INTO schema_migrations (version) VALUES (2)");
      }
      const statusMigration = await client.query("SELECT 1 FROM schema_migrations WHERE version=3");
      if (!statusMigration.rowCount) {
        const legacyRows = await client.query("SELECT * FROM jobs WHERE status='needs_review'");
        for (const row of legacyRows.rows) {
          let classified: ReturnType<typeof classifyLegacyReview>;
          try {
            classified = classifyLegacyReview(
              this.decrypt(row.task, `job:${row.id}:task:v2`),
              row.output === null ? null : this.decrypt(row.output, `job:${row.id}:output:v2`),
              row.validation,
              row.error_code,
            );
          } catch {
            classified = {
              status: "failed",
              validation: row.validation,
              errorCode: "legacy_migration_failed",
              errorMessage: "The historical review record could not be revalidated.",
            };
          }
          await client.query(
            `UPDATE jobs SET status=$2, validation=$3, error_code=$4, error_message=$5,
             updated_at=NOW() WHERE id=$1`,
            [
              row.id,
              classified.status,
              classified.validation,
              classified.errorCode,
              classified.errorMessage,
            ],
          );
          const sequenceResult = await client.query(
            "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM job_events WHERE job_id=$1",
            [row.id],
          );
          const sequence = Number(sequenceResult.rows[0].sequence);
          await client.query(
            `INSERT INTO job_events (id,job_id,sequence,type,data,created_at)
             VALUES ($1,$2,$3,'status',$4,NOW())`,
            [
              randomUUID(),
              row.id,
              sequence,
              this.encrypt(
                { status: classified.status, migratedFrom: "needs_review" },
                `job:${row.id}:event:${sequence}:v2`,
              ),
            ],
          );
          await client.query(
            `INSERT INTO audit_events
             (id,actor_id,action,resource_type,resource_id,metadata,created_at)
             VALUES ($1,'migration','job.status_reclassified','job',$2,$3,NOW())`,
            [randomUUID(), row.id, { from: "needs_review", to: classified.status }],
          );
        }
        await client.query("INSERT INTO schema_migrations (version) VALUES (3)");
      }
      const historicalEventMigration = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version=4",
      );
      if (!historicalEventMigration.rowCount) {
        const candidateRows = await client.query(`
          SELECT j.id, j.status, j.updated_at
          FROM jobs AS j
          WHERE NOT EXISTS (
            SELECT 1 FROM job_events AS e WHERE e.job_id = j.id
          )
          ORDER BY j.created_at ASC, j.id ASC
          FOR UPDATE OF j
        `);
        const jobIds = candidateRows.rows.map((row) => String(row.id));
        const auditRows = jobIds.length
          ? await client.query(
              `SELECT resource_id, action, created_at
               FROM audit_events
               WHERE resource_type='job' AND resource_id = ANY($1::text[])
               ORDER BY created_at ASC, id ASC`,
              [jobIds],
            )
          : { rows: [] };
        const auditsByJob = new Map<string, HistoricalAuditStatusRecord[]>();
        for (const row of auditRows.rows) {
          const jobId = String(row.resource_id);
          const audits = auditsByJob.get(jobId) ?? [];
          audits.push({
            action: String(row.action),
            createdAt: new Date(row.created_at).toISOString(),
          });
          auditsByJob.set(jobId, audits);
        }
        const report: HistoricalJobEventRecoveryReport = {
          version: 4,
          candidateJobs: candidateRows.rows.length,
          insertedEvents: 0,
          auditDerivedEvents: 0,
          currentStatusEvents: 0,
          jobsWithUnresolvedHistory: 0,
          ignoredAuditActions: 0,
        };
        for (const row of candidateRows.rows) {
          const currentStatus = JobStatusSchema.parse(row.status);
          const reconstructed = reconstructHistoricalJobEventData(
            currentStatus,
            new Date(row.updated_at).toISOString(),
            auditsByJob.get(String(row.id)) ?? [],
          );
          if (reconstructed.hasUnresolvedHistory) report.jobsWithUnresolvedHistory += 1;
          report.ignoredAuditActions += reconstructed.ignoredAuditActions;
          for (const [sequence, event] of reconstructed.events.entries()) {
            const inserted = await client.query(
              `INSERT INTO job_events (id,job_id,sequence,type,data,created_at)
               VALUES ($1,$2,$3,'status',$4,$5)
               ON CONFLICT (job_id, sequence) DO NOTHING`,
              [
                randomUUID(),
                row.id,
                sequence,
                this.encrypt(event.data, `job:${row.id}:event:${sequence}:v2`),
                event.createdAt,
              ],
            );
            if (inserted.rowCount) {
              report.insertedEvents += inserted.rowCount ?? 0;
              if (event.source === "audit_events") report.auditDerivedEvents += 1;
              else report.currentStatusEvents += 1;
            }
          }
        }
        console.info(`[persistence] historical job event recovery ${JSON.stringify(report)}`);
        await client.query("INSERT INTO schema_migrations (version) VALUES (4)");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async create(job: Job): Promise<Job> {
    const result = await this.pool.query(
      `INSERT INTO jobs (
        id, status, request_hash, idempotency_key, caller_id, task, route, output,
        error_code, error_message, usage, validation, created_at, updated_at, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
      ) RETURNING *`,
      [
        job.id,
        job.status,
        job.requestHash,
        job.idempotencyKey,
        job.callerId,
        this.encrypt(job.task, `job:${job.id}:task:v2`),
        job.route,
        job.output === null ? null : this.encrypt(job.output, `job:${job.id}:output:v2`),
        job.errorCode,
        job.errorMessage,
        job.usage,
        job.validation,
        job.createdAt,
        job.updatedAt,
        job.expiresAt,
      ],
    );
    return this.rowToJob(result.rows[0]);
  }

  async transitionJob(id: string, patch: Partial<Job>, audit: AuditEvent): Promise<Job> {
    if (!patch.status) throw new Error("job_status_required");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [id]);
      const currentResult = await client.query("SELECT * FROM jobs WHERE id=$1", [id]);
      if (!currentResult.rowCount) throw new Error("job_not_found");
      const current = this.rowToJob(currentResult.rows[0]);
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      const updateResult = await client.query(
        `UPDATE jobs SET status=$2, route=$3, output=$4, error_code=$5, error_message=$6,
         usage=$7, validation=$8, task=$9, updated_at=$10 WHERE id=$1 RETURNING *`,
        [
          id,
          next.status,
          next.route,
          next.output === null ? null : this.encrypt(next.output, `job:${next.id}:output:v2`),
          next.errorCode,
          next.errorMessage,
          next.usage,
          next.validation,
          this.encrypt(next.task, `job:${next.id}:task:v2`),
          next.updatedAt,
        ],
      );
      const sequenceResult = await client.query(
        "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM job_events WHERE job_id=$1",
        [id],
      );
      const sequence = Number(sequenceResult.rows[0].sequence);
      const eventData = { status: next.status };
      await client.query(
        `INSERT INTO job_events (id,job_id,sequence,type,data,created_at)
         VALUES ($1,$2,$3,'status',$4,$5)`,
        [
          randomUUID(),
          id,
          sequence,
          this.encrypt(eventData, `job:${id}:event:${sequence}:v2`),
          next.updatedAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events (
          id,actor_id,action,resource_type,resource_id,metadata,created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          audit.id,
          audit.actorId,
          audit.action,
          audit.resourceType,
          audit.resourceId,
          audit.metadata,
          audit.createdAt,
        ],
      );
      await client.query("COMMIT");
      return this.rowToJob(updateResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<Job | null> {
    const result = await this.pool.query("SELECT * FROM jobs WHERE id = $1", [id]);
    return result.rowCount ? this.rowToJob(result.rows[0]) : null;
  }

  async findByIdempotency(callerId: string, key: string): Promise<Job | null> {
    const result = await this.pool.query(
      "SELECT * FROM jobs WHERE caller_id = $1 AND idempotency_key = $2",
      [callerId, key],
    );
    return result.rowCount ? this.rowToJob(result.rows[0]) : null;
  }

  async list(limit = 100): Promise<Job[]> {
    const result = await this.pool.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1", [
      Math.min(limit, 500),
    ]);
    return result.rows.map((row) => this.rowToJob(row));
  }

  async update(id: string, patch: Partial<Job>): Promise<Job> {
    const current = await this.findById(id);
    if (!current) {
      throw new Error("job_not_found");
    }
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    const result = await this.pool.query(
      `UPDATE jobs SET status=$2, route=$3, output=$4, error_code=$5, error_message=$6,
       usage=$7, validation=$8, task=$9, updated_at=$10 WHERE id=$1 RETURNING *`,
      [
        id,
        next.status,
        next.route,
        next.output === null ? null : this.encrypt(next.output, `job:${next.id}:output:v2`),
        next.errorCode,
        next.errorMessage,
        next.usage,
        next.validation,
        this.encrypt(next.task, `job:${next.id}:task:v2`),
        next.updatedAt,
      ],
    );
    return this.rowToJob(result.rows[0]);
  }

  async appendEvent(
    jobId: string,
    type: JobEvent["type"],
    data: Record<string, unknown>,
  ): Promise<JobEvent> {
    const sequenceResult = await this.pool.query(
      "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM job_events WHERE job_id = $1",
      [jobId],
    );
    const event: JobEvent = {
      id: randomUUID(),
      jobId,
      sequence: Number(sequenceResult.rows[0].sequence),
      type,
      data,
      createdAt: new Date().toISOString(),
    };
    await this.pool.query(
      "INSERT INTO job_events (id, job_id, sequence, type, data, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        event.id,
        event.jobId,
        event.sequence,
        event.type,
        this.encrypt(event.data, `job:${event.jobId}:event:${event.sequence}:v2`),
        event.createdAt,
      ],
    );
    return event;
  }

  async events(jobId: string, afterSequence = -1): Promise<JobEvent[]> {
    const result = await this.pool.query(
      "SELECT * FROM job_events WHERE job_id = $1 AND sequence > $2 ORDER BY sequence ASC",
      [jobId, afterSequence],
    );
    return result.rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      sequence: row.sequence,
      type: row.type,
      data: this.decrypt(row.data, `job:${row.job_id}:event:${row.sequence}:v2`),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async saveQuotaSnapshot(snapshot: QuotaSnapshot): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT snapshot FROM quota_current WHERE provider=$1 FOR UPDATE",
        [snapshot.provider],
      );
      const previous = current.rowCount ? (current.rows[0].snapshot as QuotaSnapshot) : null;
      const changed =
        !previous ||
        JSON.stringify({ ...previous, fetchedAt: null, stale: null }) !==
          JSON.stringify({ ...snapshot, fetchedAt: null, stale: null });
      await client.query(
        `INSERT INTO quota_current (provider, snapshot, updated_at) VALUES ($1,$2,$3)
         ON CONFLICT (provider) DO UPDATE SET snapshot=EXCLUDED.snapshot, updated_at=EXCLUDED.updated_at`,
        [snapshot.provider, snapshot, snapshot.fetchedAt],
      );
      if (changed) {
        await client.query(
          "INSERT INTO quota_snapshots (id, provider, snapshot, created_at) VALUES ($1,$2,$3,$4)",
          [randomUUID(), snapshot.provider, snapshot, snapshot.fetchedAt],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async latestQuotaSnapshot(): Promise<QuotaSnapshot | null> {
    const current = await this.pool.query(
      "SELECT snapshot FROM quota_current WHERE provider='codex'",
    );
    if (current.rowCount) return current.rows[0].snapshot as QuotaSnapshot;
    const history = await this.pool.query(
      "SELECT snapshot FROM quota_snapshots WHERE provider='codex' ORDER BY created_at DESC LIMIT 1",
    );
    return history.rowCount ? (history.rows[0].snapshot as QuotaSnapshot) : null;
  }

  async saveModelCatalog(snapshot: ModelCatalogSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_catalog_current (provider, snapshot, updated_at) VALUES ('codex',$1,$2)
       ON CONFLICT (provider) DO UPDATE SET snapshot=EXCLUDED.snapshot, updated_at=EXCLUDED.updated_at`,
      [snapshot, snapshot.fetchedAt],
    );
  }

  async latestModelCatalog(): Promise<ModelCatalogSnapshot | null> {
    const result = await this.pool.query(
      "SELECT snapshot FROM model_catalog_current WHERE provider='codex'",
    );
    return result.rowCount ? (result.rows[0].snapshot as ModelCatalogSnapshot) : null;
  }

  async readChatGptWebStatus(): Promise<ChatGptWebStatus> {
    const result = await this.pool.query(
      "SELECT status FROM chatgpt_web_status WHERE singleton=TRUE",
    );
    return result.rowCount
      ? parseChatGptWebStatus(result.rows[0].status)
      : defaultChatGptWebStatus();
  }

  async saveChatGptWebStatus(status: ChatGptWebStatus): Promise<void> {
    const parsed = parseChatGptWebStatus(status);
    await this.pool.query(
      `INSERT INTO chatgpt_web_status (singleton,status,updated_at)
       VALUES (TRUE,$1,$2)
       ON CONFLICT (singleton) DO UPDATE SET status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`,
      [parsed, parsed.updatedAt],
    );
  }

  async createChatGptWebQualificationRun(
    run: ChatGptWebQualificationRun,
  ): Promise<ChatGptWebQualificationRun> {
    const parsed = ChatGptWebQualificationRunSchema.parse(run);
    await this.pool.query(
      `INSERT INTO chatgpt_web_qualification_runs (id,run,created_at,updated_at)
       VALUES ($1,$2,$3,$4)`,
      [parsed.id, parsed, parsed.createdAt, parsed.updatedAt],
    );
    return parsed;
  }

  async findChatGptWebQualificationRun(id: string): Promise<ChatGptWebQualificationRun | null> {
    const result = await this.pool.query(
      "SELECT run FROM chatgpt_web_qualification_runs WHERE id=$1",
      [id],
    );
    return result.rowCount ? ChatGptWebQualificationRunSchema.parse(result.rows[0].run) : null;
  }

  async updateChatGptWebQualificationRun(
    id: string,
    patch: Partial<ChatGptWebQualificationRun>,
  ): Promise<ChatGptWebQualificationRun> {
    const current = await this.findChatGptWebQualificationRun(id);
    if (!current) throw new Error("chatgpt_web_qualification_not_found");
    const updated = ChatGptWebQualificationRunSchema.parse({
      ...current,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    });
    await this.pool.query(
      "UPDATE chatgpt_web_qualification_runs SET run=$2,updated_at=$3 WHERE id=$1",
      [id, updated, updated.updatedAt],
    );
    return updated;
  }

  async listChatGptWebQualificationRuns(limit = 20): Promise<ChatGptWebQualificationRun[]> {
    const result = await this.pool.query(
      "SELECT run FROM chatgpt_web_qualification_runs ORDER BY created_at DESC LIMIT $1",
      [Math.min(limit, 100)],
    );
    return result.rows.map((row) => ChatGptWebQualificationRunSchema.parse(row.run));
  }

  async listModelSettings(): Promise<ModelSetting[]> {
    const result = await this.pool.query("SELECT * FROM model_settings ORDER BY model_id");
    return result.rows.map((row) => ({
      modelId: row.model_id,
      enabled: row.enabled,
      updatedAt: new Date(row.updated_at).toISOString(),
      updatedBy: row.updated_by,
    }));
  }

  async setModelEnabled(modelId: string, enabled: boolean, actorId: string): Promise<ModelSetting> {
    const result = await this.pool.query(
      `INSERT INTO model_settings (model_id, enabled, updated_at, updated_by) VALUES ($1,$2,NOW(),$3)
       ON CONFLICT (model_id) DO UPDATE SET enabled=EXCLUDED.enabled,
         updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by RETURNING *`,
      [modelId, enabled, actorId],
    );
    const row = result.rows[0];
    return {
      modelId: row.model_id,
      enabled: row.enabled,
      updatedAt: new Date(row.updated_at).toISOString(),
      updatedBy: row.updated_by,
    };
  }

  async setModelEnabledIdempotent(
    modelId: string,
    enabled: boolean,
    actorId: string,
    idempotencyKey: string,
    requestHashValue: string,
  ): Promise<ModelSettingResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query(
        "SELECT request_hash, response FROM model_setting_requests WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE",
        [actorId, idempotencyKey],
      );
      if (prior.rowCount) {
        if (prior.rows[0].request_hash !== requestHashValue)
          throw new Error("idempotency_conflict");
        await client.query("COMMIT");
        return { setting: prior.rows[0].response as ModelSetting, replayed: true };
      }
      const updated = await client.query(
        `INSERT INTO model_settings (model_id, enabled, updated_at, updated_by) VALUES ($1,$2,NOW(),$3)
         ON CONFLICT (model_id) DO UPDATE SET enabled=EXCLUDED.enabled,
           updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by RETURNING *`,
        [modelId, enabled, actorId],
      );
      const row = updated.rows[0];
      const setting: ModelSetting = {
        modelId: row.model_id,
        enabled: row.enabled,
        updatedAt: new Date(row.updated_at).toISOString(),
        updatedBy: row.updated_by,
      };
      await client.query(
        "INSERT INTO model_setting_requests (actor_id,idempotency_key,request_hash,response,created_at) VALUES ($1,$2,$3,$4,NOW())",
        [actorId, idempotencyKey, requestHashValue, setting],
      );
      await client.query("COMMIT");
      return { setting, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private rowToSessionThread(row: Record<string, any>): SessionThread {
    return {
      sessionKey: row.session_key,
      callerId: row.caller_id,
      model: row.model,
      effort: row.effort,
      turnCount: Number(row.turn_count),
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: new Date(row.last_used_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  async upsertSessionThread(thread: SessionThread): Promise<SessionThread> {
    const result = await this.pool.query(
      `INSERT INTO session_threads (
        session_key, caller_id, model, effort, turn_count, created_at, last_used_at, expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (session_key) DO UPDATE SET
        caller_id=EXCLUDED.caller_id,
        model=EXCLUDED.model,
        effort=EXCLUDED.effort,
        turn_count=EXCLUDED.turn_count,
        created_at=EXCLUDED.created_at,
        last_used_at=EXCLUDED.last_used_at,
        expires_at=EXCLUDED.expires_at
      RETURNING *`,
      [
        thread.sessionKey,
        thread.callerId,
        thread.model,
        thread.effort,
        thread.turnCount,
        thread.createdAt,
        thread.lastUsedAt,
        thread.expiresAt,
      ],
    );
    return this.rowToSessionThread(result.rows[0]);
  }

  async findSessionThread(sessionKey: string): Promise<SessionThread | null> {
    const result = await this.pool.query("SELECT * FROM session_threads WHERE session_key=$1", [
      sessionKey,
    ]);
    return result.rowCount ? this.rowToSessionThread(result.rows[0]) : null;
  }

  async listSessionThreads(
    actorId: string,
    isAdmin: boolean,
    limit = 100,
  ): Promise<SessionThread[]> {
    const result = await this.pool.query(
      isAdmin
        ? "SELECT * FROM session_threads ORDER BY last_used_at DESC LIMIT $1"
        : "SELECT * FROM session_threads WHERE caller_id=$1 ORDER BY last_used_at DESC LIMIT $2",
      isAdmin ? [Math.min(limit, 500)] : [actorId, Math.min(limit, 500)],
    );
    return result.rows.map((row) => this.rowToSessionThread(row));
  }

  async deleteExpiredSessionThreads(now: Date): Promise<number> {
    const result = await this.pool.query("DELETE FROM session_threads WHERE expires_at <= $1", [
      now.toISOString(),
    ]);
    return result.rowCount ?? 0;
  }

  async createApiKey(record: StoredApiKey): Promise<StoredApiKey> {
    const result = await this.pool.query(
      `INSERT INTO api_keys (
        id, created_by, name, prefix, digest, scopes, execution_default_preset,
        execution_allowed_presets, rate_limit_per_minute, expires_at, revoked_at, created_at,
        last_used_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        record.id,
        record.createdBy,
        record.name,
        record.prefix,
        record.digest,
        record.scopes,
        record.executionPolicy.defaultPreset,
        record.executionPolicy.allowedPresets,
        record.rateLimitPerMinute,
        record.expiresAt,
        record.revokedAt,
        record.createdAt,
        record.lastUsedAt,
      ],
    );
    return this.rowToApiKey(result.rows[0]);
  }

  async createApiKeyIdempotent(
    actorId: string,
    idempotencyKey: string,
    requestHashValue: string,
    record: StoredApiKey,
    plaintext: string,
  ): Promise<ApiKeyCreationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `api-key:${actorId}:${idempotencyKey}`,
      ]);
      const existing = await client.query(
        "SELECT request_hash, response FROM api_key_requests WHERE actor_id=$1 AND idempotency_key=$2",
        [actorId, idempotencyKey],
      );
      if (existing.rowCount) {
        if (existing.rows[0].request_hash !== requestHashValue) {
          throw new Error("idempotency_conflict");
        }
        const saved = this.decrypt<{ record: StoredApiKey; plaintext: string }>(
          existing.rows[0].response,
          `api-key-request:${actorId}:${idempotencyKey}:v2`,
        );
        saved.record.executionPolicy ??= {
          defaultPreset: saved.record.scopes.includes("admin") ? "full" : "restricted",
          allowedPresets: saved.record.scopes.includes("admin")
            ? ["restricted", "confirm", "full"]
            : ["restricted"],
        };
        await client.query("COMMIT");
        return { ...saved, replayed: true };
      }
      await client.query(
        `INSERT INTO api_keys (
          id, created_by, name, prefix, digest, scopes, execution_default_preset,
          execution_allowed_presets, rate_limit_per_minute, expires_at, revoked_at, created_at,
          last_used_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          record.id,
          record.createdBy,
          record.name,
          record.prefix,
          record.digest,
          record.scopes,
          record.executionPolicy.defaultPreset,
          record.executionPolicy.allowedPresets,
          record.rateLimitPerMinute,
          record.expiresAt,
          record.revokedAt,
          record.createdAt,
          record.lastUsedAt,
        ],
      );
      await client.query(
        `INSERT INTO api_key_requests
          (actor_id,idempotency_key,request_hash,api_key_id,response,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          actorId,
          idempotencyKey,
          requestHashValue,
          record.id,
          this.encrypt({ record, plaintext }, `api-key-request:${actorId}:${idempotencyKey}:v2`),
          record.createdAt,
        ],
      );
      await client.query("COMMIT");
      return { record, plaintext, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private rowToApiKey(row: Record<string, any>): StoredApiKey {
    return {
      id: row.id,
      createdBy: row.created_by,
      name: row.name,
      prefix: row.prefix,
      digest: row.digest,
      scopes: row.scopes,
      executionPolicy: {
        defaultPreset: row.execution_default_preset ?? "restricted",
        allowedPresets: row.execution_allowed_presets ?? ["restricted"],
      },
      rateLimitPerMinute: row.rate_limit_per_minute,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    };
  }

  async findApiKeyByPrefix(prefix: string): Promise<StoredApiKey | null> {
    const result = await this.pool.query("SELECT * FROM api_keys WHERE prefix=$1", [prefix]);
    return result.rowCount ? this.rowToApiKey(result.rows[0]) : null;
  }

  async findApiKeyById(id: string): Promise<StoredApiKey | null> {
    const result = await this.pool.query("SELECT * FROM api_keys WHERE id=$1", [id]);
    return result.rowCount ? this.rowToApiKey(result.rows[0]) : null;
  }

  async listApiKeys(): Promise<ApiKeyMetadata[]> {
    const result = await this.pool.query("SELECT * FROM api_keys ORDER BY created_at DESC");
    return result.rows.map((row) => apiKeyWithoutDigest(this.rowToApiKey(row)));
  }

  async listApiKeysForActor(actorId: string, isAdmin: boolean): Promise<ApiKeyMetadata[]> {
    const result = await this.pool.query(
      isAdmin
        ? "SELECT * FROM api_keys ORDER BY created_at DESC"
        : "SELECT * FROM api_keys WHERE created_by=$1 ORDER BY created_at DESC",
      isAdmin ? [] : [actorId],
    );
    return result.rows.map((row) => apiKeyWithoutDigest(this.rowToApiKey(row)));
  }

  async touchApiKey(id: string): Promise<void> {
    await this.pool.query("UPDATE api_keys SET last_used_at=NOW() WHERE id=$1", [id]);
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.pool.query("UPDATE api_keys SET revoked_at=NOW() WHERE id=$1", [id]);
  }

  async apiKeyCount(): Promise<number> {
    const result = await this.pool.query("SELECT COUNT(*)::integer AS count FROM api_keys");
    return Number(result.rows[0].count);
  }

  async activeAdminApiKeyCount(): Promise<number> {
    const result = await this.pool.query(
      "SELECT COUNT(*)::integer AS count FROM api_keys WHERE revoked_at IS NULL AND 'admin'=ANY(scopes)",
    );
    return Number(result.rows[0].count);
  }

  async consumeRateLimit(subject: string, limit: number, now: Date): Promise<boolean> {
    const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
    const result = await this.pool.query(
      `INSERT INTO rate_limit_windows (subject,window_start,request_count)
       VALUES ($1,$2,1)
       ON CONFLICT (subject,window_start)
       DO UPDATE SET request_count=rate_limit_windows.request_count+1
       RETURNING request_count`,
      [subject, windowStart],
    );
    return Number(result.rows[0].request_count) <= limit;
  }

  private rowToUser(row: Record<string, any>): IdentityUser {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async createUser(user: IdentityUser): Promise<IdentityUser> {
    const result = await this.pool.query(
      "INSERT INTO identity_users (id,email,display_name,created_at) VALUES ($1,$2,$3,$4) RETURNING *",
      [user.id, user.email, user.displayName, user.createdAt],
    );
    return this.rowToUser(result.rows[0]);
  }

  async findUserByEmail(email: string): Promise<IdentityUser | null> {
    const result = await this.pool.query("SELECT * FROM identity_users WHERE email=$1", [email]);
    return result.rowCount ? this.rowToUser(result.rows[0]) : null;
  }

  async findUserById(id: string): Promise<IdentityUser | null> {
    const result = await this.pool.query("SELECT * FROM identity_users WHERE id=$1", [id]);
    return result.rowCount ? this.rowToUser(result.rows[0]) : null;
  }

  async userCount(): Promise<number> {
    const result = await this.pool.query("SELECT COUNT(*)::integer AS count FROM identity_users");
    return Number(result.rows[0].count);
  }

  private rowToPasskey(row: Record<string, any>): StoredPasskey {
    return {
      id: row.id,
      userId: row.user_id,
      credentialId: row.credential_id,
      publicKeyBase64: row.public_key_base64,
      counter: Number(row.counter),
      transports: row.transports,
      deviceType: row.device_type,
      backedUp: row.backed_up,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async createPasskey(passkey: StoredPasskey): Promise<void> {
    await this.pool.query(
      `INSERT INTO passkeys (
        id,user_id,credential_id,public_key_base64,counter,transports,
        device_type,backed_up,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        passkey.id,
        passkey.userId,
        passkey.credentialId,
        passkey.publicKeyBase64,
        passkey.counter,
        passkey.transports,
        passkey.deviceType,
        passkey.backedUp,
        passkey.createdAt,
      ],
    );
  }

  async passkeysForUser(userId: string): Promise<StoredPasskey[]> {
    const result = await this.pool.query("SELECT * FROM passkeys WHERE user_id=$1", [userId]);
    return result.rows.map((row) => this.rowToPasskey(row));
  }

  async findPasskey(credentialId: string): Promise<StoredPasskey | null> {
    const result = await this.pool.query("SELECT * FROM passkeys WHERE credential_id=$1", [
      credentialId,
    ]);
    return result.rowCount ? this.rowToPasskey(result.rows[0]) : null;
  }

  async updatePasskeyCounter(id: string, counter: number): Promise<void> {
    await this.pool.query("UPDATE passkeys SET counter=$2 WHERE id=$1", [id, counter]);
  }

  async createChallenge(challenge: AuthChallenge): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_challenges (id,user_id,purpose,challenge,expires_at,used_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        challenge.id,
        challenge.userId,
        challenge.purpose,
        challenge.challenge,
        challenge.expiresAt,
        challenge.usedAt,
      ],
    );
  }

  async consumeChallenge(id: string): Promise<AuthChallenge | null> {
    const result = await this.pool.query(
      `UPDATE auth_challenges SET used_at=NOW()
       WHERE id=$1 AND used_at IS NULL AND expires_at>NOW() RETURNING *`,
      [id],
    );
    if (!result.rowCount) {
      return null;
    }
    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      purpose: row.purpose,
      challenge: row.challenge,
      expiresAt: new Date(row.expires_at).toISOString(),
      usedAt: null,
    };
  }

  async createSession(session: AuthSession): Promise<void> {
    await this.pool.query(
      "INSERT INTO auth_sessions (id,user_id,digest,expires_at,created_at) VALUES ($1,$2,$3,$4,$5)",
      [session.id, session.userId, session.digest, session.expiresAt, session.createdAt],
    );
  }

  async findSessionByDigest(digest: string): Promise<AuthSession | null> {
    const result = await this.pool.query(
      "SELECT * FROM auth_sessions WHERE digest=$1 AND expires_at>NOW()",
      [digest],
    );
    if (!result.rowCount) {
      return null;
    }
    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      digest: row.digest,
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async deleteSessionByDigest(digest: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM auth_sessions WHERE digest=$1", [digest]);
    return (result.rowCount ?? 0) > 0;
  }

  async createRecoveryCodes(records: RecoveryCodeRecord[]): Promise<void> {
    for (const record of records) {
      await this.pool.query(
        "INSERT INTO recovery_codes (id,user_id,digest,created_at,used_at) VALUES ($1,$2,$3,$4,$5)",
        [record.id, record.userId, record.digest, record.createdAt, record.usedAt],
      );
    }
  }

  async consumeRecoveryCode(userId: string, digest: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE recovery_codes SET used_at=NOW()
       WHERE user_id=$1 AND digest=$2 AND used_at IS NULL`,
      [userId, digest],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (
        id,actor_id,action,resource_type,resource_id,metadata,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        event.id,
        event.actorId,
        event.action,
        event.resourceType,
        event.resourceId,
        event.metadata,
        event.createdAt,
      ],
    );
  }

  async listAudit(limit = 100): Promise<AuditEvent[]> {
    const result = await this.pool.query(
      "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT $1",
      [Math.min(limit, 500)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      metadata: row.metadata,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async listDeletionReceipts(limit = 100): Promise<DeletionReceipt[]> {
    const result = await this.pool.query(
      "SELECT * FROM deletion_receipts ORDER BY payload_deleted_at DESC LIMIT $1",
      [Math.min(limit, 500)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      payloadDeletedAt: new Date(row.payload_deleted_at).toISOString(),
      metadataDeleteAfter: new Date(row.metadata_delete_after).toISOString(),
    }));
  }

  async deleteExpiredPayloads(now: Date): Promise<number> {
    const result = await this.pool.query(
      "SELECT id, task, created_at FROM jobs WHERE expires_at <= $1",
      [now.toISOString()],
    );
    let deleted = 0;
    for (const row of result.rows) {
      const task = this.decrypt<Job["task"]>(row.task, `job:${row.id}:task:v2`);
      if (task.objective === "[deleted]") {
        continue;
      }
      const tombstone = {
        ...task,
        objective: "[deleted]",
        requiredContext: [],
        constraints: [],
      };
      await this.pool.query("UPDATE jobs SET task=$2, output=NULL, updated_at=NOW() WHERE id=$1", [
        row.id,
        this.encrypt(tombstone, `job:${row.id}:task:v2`),
      ]);
      await this.pool.query("DELETE FROM job_events WHERE job_id=$1", [row.id]);
      await this.pool.query(
        `INSERT INTO deletion_receipts (
          id,job_id,payload_deleted_at,metadata_delete_after
        ) VALUES ($1,$2,$3,$4) ON CONFLICT (job_id) DO NOTHING`,
        [
          randomUUID(),
          row.id,
          now.toISOString(),
          new Date(new Date(row.created_at).getTime() + 90 * 86_400_000).toISOString(),
        ],
      );
      deleted += 1;
    }
    return deleted;
  }

  async deleteExpiredMetadata(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    const result = await this.pool.query("DELETE FROM jobs WHERE created_at <= $1", [cutoff]);
    await this.pool.query("DELETE FROM audit_events WHERE created_at <= $1", [cutoff]);
    return result.rowCount ?? 0;
  }
}
