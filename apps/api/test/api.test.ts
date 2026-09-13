import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  configuredChatGptWebAccountConfigs,
  defaultChatGptWebStatus,
  type JobRepository,
} from "@aialra/persistence";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { JOB_REPOSITORY } from "../src/tokens.js";

describe("AIALRA Model Router API", () => {
  let app: INestApplication;
  let bootstrapKey = "";

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTHENTIK_TRUST_PROXY = "true";
    process.env.INTERNAL_PROXY_SECRET = "synthetic-internal-proxy-secret-000000000000";
    process.env.API_KEY_PEPPER = "synthetic-api-key-pepper-with-more-than-32-bytes";
    process.env.BOOTSTRAP_ADMIN_TOKEN = "synthetic-bootstrap-token";
    process.env.WEBAUTHN_ORIGIN = "https://router.example.com";
    process.env.CHATGPT_WEB_DIAGNOSTIC_ENABLED = "true";
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports health without authentication", async () => {
    await request(app.getHttpServer()).get("/healthz").expect(200).expect({
      status: "ok",
      service: "aialra-model-router-api",
    });
  });

  it("serves 192 health and readiness checks in six 32-request waves", async () => {
    const paths = Array.from({ length: 192 }, (_, index) =>
      index % 3 === 0 ? "/readyz" : "/healthz",
    );
    for (let offset = 0; offset < paths.length; offset += 32) {
      const responses = await Promise.all(
        paths.slice(offset, offset + 32).map((path) => request(app.getHttpServer()).get(path)),
      );
      expect(responses.map((response) => response.status).every((status) => status === 200)).toBe(
        true,
      );
    }
  });

  it("bootstraps an administrator key with the full execution ceiling", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/bootstrap/keys")
      .set("X-Bootstrap-Token", process.env.BOOTSTRAP_ADMIN_TOKEN!)
      .send({})
      .expect(201);

    bootstrapKey = created.body.key;
    expect(created.body.executionPolicy).toEqual({
      defaultPreset: "full",
      allowedPresets: ["restricted", "confirm", "full"],
    });
    expect(created.body.executionChannels).toEqual(["codex", "chatgpt_web"]);
  });

  it("creates idempotent jobs", async () => {
    const payload = { task: { objective: "Classify a synthetic message", taskKind: "bounded" } };
    const first = await request(app.getHttpServer())
      .post("/api/v1/jobs")
      .set("Idempotency-Key", "test-key")
      .send(payload)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post("/api/v1/jobs")
      .set("Idempotency-Key", "test-key")
      .send(payload)
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect(first.body.status).toBe("queued");
    expect(first.body.task.permissions.preset).toBe("full");
  });

  it("creates only one job when 32 identical requests arrive together", async () => {
    const payload = {
      task: { objective: "Synthetic parallel idempotency check", taskKind: "bounded" },
    };
    const key = "synthetic-parallel-idempotency-32";
    const repository = app.get<JobRepository>(JOB_REPOSITORY);
    const originalLookup = repository.findByIdempotency.bind(repository);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = vi
      .spyOn(repository, "findByIdempotency")
      .mockImplementation(async (caller, value) => {
        const found = await originalLookup(caller, value);
        if (value === key) {
          arrived += 1;
          if (arrived === 32) release();
          await gate;
        }
        return found;
      });
    const timeout = setTimeout(release, 10_000);
    let responses;
    try {
      responses = await Promise.all(
        Array.from({ length: 32 }, () =>
          request(app.getHttpServer())
            .post("/api/v1/jobs")
            .set("Idempotency-Key", key)
            .send(payload),
        ),
      );
    } finally {
      clearTimeout(timeout);
      lookup.mockRestore();
    }
    expect(arrived).toBe(32);
    expect(responses.map((response) => response.status).every((status) => status === 201)).toBe(
      true,
    );
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
    const [jobId] = new Set(responses.map((response) => response.body.id));
    expect((await repository.list(100)).filter((job) => job.id === jobId)).toHaveLength(1);
    expect(
      (await repository.events(jobId)).filter((event) => event.type === "status"),
    ).toHaveLength(2);
  });

  it("returns a conflict when different payloads race with one idempotency key", async () => {
    const key = "synthetic-parallel-conflict";
    const repository = app.get<JobRepository>(JOB_REPOSITORY);
    const originalLookup = repository.findByIdempotency.bind(repository);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = vi
      .spyOn(repository, "findByIdempotency")
      .mockImplementation(async (caller, value) => {
        const found = await originalLookup(caller, value);
        if (value === key) {
          arrived += 1;
          if (arrived === 2) release();
          await gate;
        }
        return found;
      });
    const timeout = setTimeout(release, 10_000);
    let responses;
    try {
      responses = await Promise.all(
        ["first", "second"].map((suffix) =>
          request(app.getHttpServer())
            .post("/api/v1/jobs")
            .set("Idempotency-Key", key)
            .send({ task: { objective: `Synthetic conflict ${suffix}`, taskKind: "bounded" } }),
        ),
      );
    } finally {
      clearTimeout(timeout);
      lookup.mockRestore();
    }
    expect(arrived).toBe(2);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.error.code).toBe(
      "idempotency_conflict",
    );
    expect((await repository.list(100)).filter((job) => job.idempotencyKey === key)).toHaveLength(
      1,
    );
  });

  it("keeps the ChatGPT web channel disabled until an administrator opens the experiment", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/jobs")
      .set("Idempotency-Key", "chatgpt-web-disabled")
      .send({
        task: {
          objective: "Synthetic browser probe",
          executionChannel: "chatgpt_web",
          model: "chatgpt-web.auto",
          chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
          deadlineMs: 600_000,
        },
      })
      .expect(409);

    expect(response.body.error.code).toBe("chatgpt_web_disabled");
  });

  it("rejects persistent web chats and Router session reuse before creating a job", async () => {
    const persistent = await request(app.getHttpServer())
      .post("/api/v1/jobs")
      .set("Idempotency-Key", "persistent-web-chat")
      .send({
        task: {
          objective: "Synthetic persistent browser probe",
          executionChannel: "chatgpt_web",
          model: "chatgpt-web.auto",
          chatgptWeb: { mode: "chat", temporaryChat: false, requireSources: false },
        },
      })
      .expect(400);
    expect(persistent.body.error.code).toBe("persistent_chat_disabled");

    const resumed = await request(app.getHttpServer())
      .post("/api/v1/jobs")
      .set("Idempotency-Key", "resumed-web-chat")
      .send({
        task: {
          objective: "Synthetic resumed browser probe",
          executionChannel: "chatgpt_web",
          model: "chatgpt-web.auto",
          sessionKey: "synthetic-web-session",
          chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
        },
      })
      .expect(400);
    expect(resumed.body.error.code).toBe("web_session_not_supported");
  });

  it("returns Retry-After while the ChatGPT web circuit is cooling down", async () => {
    const repository = app.get<JobRepository>(JOB_REPOSITORY);
    const cooldownUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    await repository.saveChatGptWebStatus({
      ...defaultChatGptWebStatus(),
      configuredEnabled: true,
      circuitState: "open",
      rateLimitState: "cooldown",
      cooldownUntil,
      retryAfter: 1800,
      lastRateLimitAt: new Date().toISOString(),
      consecutiveRateLimits: 1,
    });
    process.env.CHATGPT_WEB_ADAPTER_ENABLED = "true";
    try {
      const response = await request(app.getHttpServer())
        .post("/api/v1/jobs")
        .set("Authorization", `Bearer ${bootstrapKey}`)
        .set("Idempotency-Key", "web-cooldown")
        .send({
          task: {
            objective: "Synthetic browser probe during cooldown",
            executionChannel: "chatgpt_web",
            model: "chatgpt-web.auto",
            chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
          },
        })
        .expect(429);
      expect(response.body.error.code).toBe("chatgpt_rate_limited");
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
      expect(response.body.error.retryAfter).toBe(Number(response.headers["retry-after"]));

      await repository.saveChatGptWebStatus({
        ...defaultChatGptWebStatus(),
        configuredEnabled: true,
        effectiveConcurrency: 1,
        circuitState: "closed",
        circuitReason: null,
        rateLimitState: "recovery_probe",
        lastSubmissionAt: new Date().toISOString(),
        lastRecoveryProbeAt: new Date().toISOString(),
      });
      const recoveryResponse = await request(app.getHttpServer())
        .post("/api/v1/jobs")
        .set("Authorization", `Bearer ${bootstrapKey}`)
        .set("Idempotency-Key", "web-recovery-probe-active")
        .send({
          task: {
            objective: "Synthetic browser probe while recovery is active",
            executionChannel: "chatgpt_web",
            model: "chatgpt-web.auto",
            chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
          },
        })
        .expect(429);
      expect(recoveryResponse.body.error.code).toBe("chatgpt_rate_limited");
      expect(recoveryResponse.body.error.retryAfter).toBe(
        Number(recoveryResponse.headers["retry-after"]),
      );
    } finally {
      process.env.CHATGPT_WEB_ADAPTER_ENABLED = "false";
      await repository.saveChatGptWebStatus(defaultChatGptWebStatus());
    }
  });

  it("uses the earliest account cooldown instead of the clear global retry value", async () => {
    const repository = app.get<JobRepository>(JOB_REPOSITORY);
    await repository.syncChatGptWebAccounts(configuredChatGptWebAccountConfigs("a,b"));
    const accounts = await repository.listChatGptWebAccounts();
    const list = vi.spyOn(repository, "listChatGptWebAccounts").mockResolvedValue(
      accounts.map((account, index) => ({
        ...account,
        enabled: true,
        qualified: true,
        state: "cooldown",
        rateLimitState: "cooldown",
        lastRateLimitAt: new Date(Date.now() - 100_000).toISOString(),
        retryAfter: index === 0 ? 600 : 1200,
      })),
    );
    process.env.CHATGPT_WEB_ADAPTER_ENABLED = "true";
    try {
      const response = await request(app.getHttpServer())
        .post("/api/v1/jobs")
        .set("Authorization", `Bearer ${bootstrapKey}`)
        .set("Idempotency-Key", "pool-cooldown-only")
        .send({
          task: {
            objective: "Synthetic",
            model: "chatgpt-web.auto",
            executionChannel: "chatgpt_web",
            chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
          },
        })
        .expect(429);
      expect(response.body.error.code).toBe("chatgpt_rate_limited");
      expect(response.body.error.retryAfter).toBeGreaterThanOrEqual(499);
      expect(response.body.error.retryAfter).toBeLessThanOrEqual(500);
      expect(response.headers["retry-after"]).toBe(String(response.body.error.retryAfter));
    } finally {
      list.mockRestore();
      process.env.CHATGPT_WEB_ADAPTER_ENABLED = "false";
    }
  });

  it("returns a secret-free ChatGPT web experiment status", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/chatgpt-web/status")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .expect(200);
    expect(response.body.configuredEnabled).toBe(false);
    expect(response.body.diagnosticEnabled).toBe(true);
    expect(response.body.effectiveConcurrency).toBe(0);
    expect(response.body.circuitState).toBe("qualification_required");
    expect(JSON.stringify(response.body)).not.toMatch(/cookie|token|conversationUrl|profilePath/i);
  });

  it("rejects qualification before queuing when diagnostic mode is disabled", async () => {
    process.env.CHATGPT_WEB_DIAGNOSTIC_ENABLED = "false";
    try {
      const response = await request(app.getHttpServer())
        .post("/api/v1/chatgpt-web/qualification-runs")
        .set("Authorization", `Bearer ${bootstrapKey}`)
        .set("Idempotency-Key", "diagnostic-disabled")
        .send({ suite: "readiness", accountId: "account-a" })
        .expect(409);
      expect(response.body.error.code).toBe("chatgpt_web_diagnostic_disabled");
    } finally {
      process.env.CHATGPT_WEB_DIAGNOSTIC_ENABLED = "true";
    }
  });

  it("lists pool slots without bridge addresses and reactivates a qualified account", async () => {
    const repository = app.get<JobRepository>(JOB_REPOSITORY);
    await repository.syncChatGptWebAccounts(configuredChatGptWebAccountConfigs("a,b"));
    await repository.updateChatGptWebAccount("account-a", {
      qualified: true,
      state: "disabled",
      authenticated: true,
      extensionConnected: true,
      pageReady: true,
      sandboxVerified: true,
    });

    const accounts = await request(app.getHttpServer())
      .get("/api/v1/chatgpt-web/accounts")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .expect(200);
    expect(accounts.body.data).toHaveLength(2);
    expect(accounts.body.data[0]).not.toHaveProperty("bridgeUrl");
    expect(accounts.body.data[0].plan).toBe("unknown");

    const updated = await request(app.getHttpServer())
      .patch("/api/v1/chatgpt-web/accounts/account-a")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .send({ plan: "pro", enabled: true })
      .expect(200);
    expect(updated.body).toMatchObject({
      accountId: "account-a",
      plan: "pro",
      enabled: true,
      state: "ready",
    });
  });

  it("creates a secret-free ChatGPT web qualification run idempotently", async () => {
    const first = await request(app.getHttpServer())
      .post("/api/v1/chatgpt-web/qualification-runs")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .set("Idempotency-Key", "synthetic-single-probe")
      .send({ suite: "single_probe" })
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post("/api/v1/chatgpt-web/qualification-runs")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .set("Idempotency-Key", "synthetic-single-probe")
      .send({ suite: "single_probe" })
      .expect(201);

    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.replayed).toBe(true);
    expect(first.body.total).toBe(1);
    expect(first.body.items[0].temporaryChatVerified).toBe(false);
    expect(JSON.stringify(first.body)).not.toMatch(/objective|outputText|conversationUrl|cookie/i);

    const concurrent = await request(app.getHttpServer())
      .post("/api/v1/chatgpt-web/qualification-runs")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .set("Idempotency-Key", "synthetic-concurrent-qualification")
      .send({ suite: "chat_3" })
      .expect(409);
    expect(concurrent.body.error.code).toBe("qualification_in_progress");
    expect(concurrent.body.error.activeRunId).toBe(first.body.id);

    await request(app.getHttpServer())
      .get(`/api/v1/chatgpt-web/qualification-runs/${first.body.id}`)
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .expect(200);
    await request(app.getHttpServer())
      .post("/api/v1/chatgpt-web/qualification-runs")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .set("Idempotency-Key", "synthetic-single-probe")
      .send({ suite: "deep_2" })
      .expect(409);
  });

  it("requires an explicit API key scope for the ChatGPT web channel", async () => {
    const ordinary = await request(app.getHttpServer())
      .post("/api/v1/keys")
      .set("Idempotency-Key", "no-chatgpt-web-scope")
      .send({
        name: "No browser scope",
        scopes: ["jobs:read", "jobs:write"],
        executionPolicy: { defaultPreset: "restricted", allowedPresets: ["restricted"] },
      })
      .expect(201);
    process.env.CHATGPT_WEB_ADAPTER_ENABLED = "true";
    try {
      const response = await request(app.getHttpServer())
        .post("/api/v1/jobs")
        .set("Authorization", `Bearer ${ordinary.body.key}`)
        .set("Idempotency-Key", "chatgpt-web-scope-rejected")
        .send({
          task: {
            objective: "Synthetic browser probe",
            executionChannel: "chatgpt_web",
            model: "chatgpt-web.auto",
            chatgptWeb: { mode: "chat", temporaryChat: true, requireSources: false },
            deadlineMs: 600_000,
          },
        })
        .expect(403);
      expect(response.body.error.code).toBe("execution_channel_not_allowed");
    } finally {
      process.env.CHATGPT_WEB_ADAPTER_ENABLED = "false";
    }
  });

  it("enforces Codex-only, ChatGPT-only, and dual-channel API keys", async () => {
    const codexOnly = await request(app.getHttpServer())
      .post("/api/v1/keys")
      .set("Idempotency-Key", "codex-only-channel-key")
      .send({
        name: "Codex only",
        scopes: ["jobs:read", "jobs:write", "quota:read"],
        executionChannels: ["codex"],
      })
      .expect(201);
    expect(codexOnly.body.executionChannels).toEqual(["codex"]);

    const chatOnly = await request(app.getHttpServer())
      .post("/api/v1/keys")
      .set("Idempotency-Key", "chat-only-channel-key")
      .send({
        name: "Chat only",
        scopes: ["jobs:read", "jobs:write", "quota:read", "chatgpt:web"],
        executionChannels: ["chatgpt_web"],
      })
      .expect(201);
    expect(chatOnly.body.executionChannels).toEqual(["chatgpt_web"]);

    const deniedCodex = await request(app.getHttpServer())
      .post("/api/v1/jobs")
      .set("Authorization", `Bearer ${chatOnly.body.key}`)
      .set("Idempotency-Key", "chat-only-codex-denied")
      .send({ task: { objective: "This Codex task must be denied" } })
      .expect(403);
    expect(deniedCodex.body.error.code).toBe("execution_channel_not_allowed");

    const dual = await request(app.getHttpServer())
      .post("/api/v1/keys")
      .set("Idempotency-Key", "dual-channel-key")
      .send({
        name: "Both channels",
        scopes: ["jobs:read", "jobs:write", "quota:read", "chatgpt:web"],
        executionChannels: ["codex", "chatgpt_web"],
      })
      .expect(201);
    expect(dual.body.executionChannels).toEqual(["codex", "chatgpt_web"]);

    const legacy = await request(app.getHttpServer())
      .post("/api/v1/keys")
      .set("Idempotency-Key", "legacy-dual-channel-key")
      .send({
        name: "Legacy both channels",
        scopes: ["jobs:read", "jobs:write", "chatgpt:web"],
      })
      .expect(201);
    expect(legacy.body.executionChannels).toEqual(["codex", "chatgpt_web"]);
  });

  it("rejects contradictory ChatGPT channel and scope settings", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/keys")
      .set("Idempotency-Key", "channel-scope-mismatch")
      .send({
        name: "Invalid chat key",
        scopes: ["jobs:read", "jobs:write"],
        executionChannels: ["chatgpt_web"],
      })
      .expect(400);
    expect(response.body.error.code).toBe("execution_channel_scope_mismatch");

    const irrelevantCodexPermission = await request(app.getHttpServer())
      .post("/api/v1/keys")
      .set("Idempotency-Key", "chat-only-with-codex-permission")
      .send({
        name: "Invalid Chat permission mix",
        scopes: ["jobs:read", "jobs:write", "chatgpt:web"],
        executionChannels: ["chatgpt_web"],
        executionPolicy: {
          defaultPreset: "full",
          allowedPresets: ["restricted", "confirm", "full"],
        },
      })
      .expect(400);
    expect(irrelevantCodexPermission.body.error.code).toBe(
      "codex_permission_without_codex_channel",
    );
  });

  it("rejects invalid legacy validation rules before creating a job", async () => {
    const before = await request(app.getHttpServer()).get("/api/v1/jobs").expect(200);
    const response = await request(app.getHttpServer())
      .post("/api/v1/jobs")
      .set("Idempotency-Key", "invalid-validation-rule")
      .send({
        task: {
          objective: "Return ROUTER_E2E_OK",
          validation: { acceptanceTests: ["Output equals ROUTER_E2E_OK"] },
        },
      })
      .expect(400);
    const after = await request(app.getHttpServer()).get("/api/v1/jobs").expect(200);

    expect(response.body.error.code).toBe("invalid_validation_rule");
    expect(after.body.data).toHaveLength(before.body.data.length);
  });

  it("keeps confirm-mode calls out of the queue until an explicit decision", async () => {
    const pending = await request(app.getHttpServer())
      .post("/api/v1/jobs")
      .set("Idempotency-Key", "confirm-mode-approved")
      .send({
        task: { objective: "Write in the isolated workspace", permissions: { preset: "confirm" } },
      })
      .expect(201);
    expect(pending.body.status).toBe("awaiting_approval");

    const approved = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${pending.body.id}/approvals`)
      .set("Idempotency-Key", "confirm-mode-approved-decision")
      .send({ decision: "approved", reason: "synthetic approval" })
      .expect(201);
    expect(approved.body.status).toBe("queued");

    const deniedPending = await request(app.getHttpServer())
      .post("/api/v1/jobs")
      .set("Idempotency-Key", "confirm-mode-denied")
      .send({ task: { objective: "Do not execute", permissions: { preset: "confirm" } } })
      .expect(201);
    const denied = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${deniedPending.body.id}/approvals`)
      .set("Idempotency-Key", "confirm-mode-denied-decision")
      .send({ decision: "denied", reason: "synthetic denial" })
      .expect(201);
    expect(denied.body.status).toBe("cancelled");
  });

  it("returns the API key retry delay in both the body and HTTP header", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/keys")
      .set("Idempotency-Key", "key-retry-after")
      .send({ name: "Rate limit test", scopes: ["quota:read"], rateLimitPerMinute: 1 })
      .expect(201);
    const repository = app.get<JobRepository>(JOB_REPOSITORY);
    const consume = vi.spyOn(repository, "consumeRateLimit").mockResolvedValue(false);
    try {
      const response = await request(app.getHttpServer())
        .get("/api/v1/quota")
        .set("Authorization", `Bearer ${created.body.key}`)
        .expect(429);
      expect(response.body.error.code).toBe("rate_limit_exceeded");
      expect(response.body.error.retryAfter).toBeGreaterThanOrEqual(1);
      expect(response.body.error.retryAfter).toBeLessThanOrEqual(60);
      expect(response.headers["retry-after"]).toBe(String(response.body.error.retryAfter));
    } finally {
      consume.mockRestore();
    }
  });

  it("enforces each API key execution ceiling", async () => {
    const ordinary = await request(app.getHttpServer())
      .post("/api/v1/keys")
      .set("Idempotency-Key", "ordinary-key")
      .send({
        name: "Ordinary test key",
        scopes: ["jobs:read", "jobs:write"],
        executionPolicy: { defaultPreset: "restricted", allowedPresets: ["restricted"] },
      })
      .expect(201);
    const denied = await request(app.getHttpServer())
      .post("/api/v1/jobs")
      .set("Authorization", `Bearer ${ordinary.body.key}`)
      .set("Idempotency-Key", "ordinary-key-full-request")
      .send({ task: { objective: "Request too much access", permissions: { preset: "full" } } })
      .expect(403);
    expect(denied.body.error.code).toBe("permission_ceiling_exceeded");

    const trusted = await request(app.getHttpServer())
      .post("/api/v1/keys")
      .set("Idempotency-Key", "trusted-key")
      .send({
        name: "Trusted agent test key",
        scopes: ["jobs:read", "jobs:write"],
        executionPolicy: {
          defaultPreset: "full",
          allowedPresets: ["restricted", "confirm", "full"],
        },
      })
      .expect(201);
    const created = await request(app.getHttpServer())
      .post("/api/v1/jobs")
      .set("Authorization", `Bearer ${trusted.body.key}`)
      .set("Idempotency-Key", "trusted-key-default-request")
      .send({ task: { objective: "Use the trusted default" } })
      .expect(201);
    expect(created.body.task.permissions.preset).toBe("full");
  });

  it("previews Luna for bounded work", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/routes/preview")
      .send({ objective: "Extract fields", taskKind: "bounded" })
      .expect(201);

    expect(response.body.model).toBe("gpt-5.6-luna");
  });

  it("lists the expanded catalog and changes model settings idempotently", async () => {
    const catalog = await request(app.getHttpServer()).get("/api/v1/models").expect(200);
    expect(catalog.body.data.map((model: { id: string }) => model.id)).toEqual(
      expect.arrayContaining([
        "gpt-5.6-sol",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex-spark",
      ]),
    );

    const first = await request(app.getHttpServer())
      .patch("/api/v1/models/gpt-5.6-sol")
      .set("Idempotency-Key", "model-setting-test")
      .send({ enabled: false })
      .expect(200);
    const replay = await request(app.getHttpServer())
      .patch("/api/v1/models/gpt-5.6-sol")
      .set("Idempotency-Key", "model-setting-test")
      .send({ enabled: false })
      .expect(200);
    expect(first.body.replayed).toBe(false);
    expect(replay.body.replayed).toBe(true);

    const conflict = await request(app.getHttpServer())
      .patch("/api/v1/models/gpt-5.6-terra")
      .set("Idempotency-Key", "model-setting-test")
      .send({ enabled: false })
      .expect(409);
    expect(conflict.body.error.code).toBe("idempotency_conflict");
  });

  it("rejects unsupported Responses parameters", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/responses")
      .send({ model: "auto", input: "hello", temperature: 0.2 })
      .expect(400);

    expect(response.body.error.code).toBe("unsupported_parameter");
  });

  it("rejects a Codex reasoning effort on a web Responses request before queuing", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/responses")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .set("Idempotency-Key", "synthetic-web-effort-response")
      .send({
        model: "chatgpt-web.auto",
        input: "Synthetic request",
        reasoning: { effort: "high" },
      })
      .expect(400);
    expect(response.body.error).toMatchObject({
      code: "unsupported_parameter",
      details: { parameter: "reasoning.effort", supportedParameter: "aialra.thinking_depth" },
    });
  });

  it("exposes audit records without task payloads", async () => {
    const response = await request(app.getHttpServer()).get("/api/v1/audit").expect(200);

    expect(response.body.data.length).toBeGreaterThan(0);
    expect(response.body.data[0]).not.toHaveProperty("task");
  });

  it("rejects an invalid batch item with a structured error", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/batches")
      .set("Idempotency-Key", "invalid-batch-key")
      .send({ requests: [{ task: {} }] })
      .expect(400);

    expect(response.body.error.code).toBe("invalid_batch_item");
  });

  it("accepts an Authentik identity only with the internal proxy proof", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/quota")
      .set("X-Aialra-Sub", "synthetic-user-id")
      .set("X-Aialra-Authenticated", "true")
      .set("X-Aialra-Groups", "aialra:access:model-router")
      .set("X-Aialra-Auth-Time", new Date().toISOString())
      .set("X-Aialra-Proxy-Proof", process.env.INTERNAL_PROXY_SECRET!)
      .expect(200);

    expect(response.body.provider).toBe("codex");
  });

  it("rejects a forged Authentik identity header", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/quota")
      .set("X-Aialra-Sub", "synthetic-user-id")
      .set("X-Aialra-Authenticated", "true")
      .set("X-Aialra-Groups", "aialra:access:model-router")
      .set("X-Aialra-Auth-Time", new Date().toISOString())
      .set("X-Aialra-Proxy-Proof", "forged-proof")
      .expect(401);

    expect(response.body.error.code).toBe("invalid_proxy_identity");
  });

  it("rejects an Authentik marker whose value is false", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/quota")
      .set("X-Aialra-Sub", "synthetic-user-id")
      .set("X-Aialra-Authenticated", "false")
      .set("X-Aialra-Groups", "aialra:access:model-router")
      .set("X-Aialra-Auth-Time", new Date().toISOString())
      .set("X-Aialra-Proxy-Proof", process.env.INTERNAL_PROXY_SECRET!)
      .expect(401);

    expect(response.body.error.code).toBe("invalid_proxy_identity");
  });

  it("uses a bootstrapped API key on an authenticated endpoint", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/quota")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .expect(200);
    expect(response.body.provider).toBe("codex");
  });

  it("rejects unsupported Chat Completions parameters", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .send({ model: "auto", messages: [{ role: "user", content: "hi" }], temperature: 0.5 })
      .expect(400);

    expect(response.body.error.code).toBe("unsupported_parameter");
  });

  it("rejects a Codex reasoning effort on a web Chat Completions request", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .send({
        model: "chatgpt-web.auto",
        messages: [{ role: "user", content: "Synthetic request" }],
        reasoning_effort: "high",
      })
      .expect(400);
    expect(response.body.error).toMatchObject({
      code: "unsupported_parameter",
      details: { parameter: "reasoning_effort", supportedParameter: "aialra.thinking_depth" },
    });
  });

  it("rejects a Chat Completions call for an unknown model before queuing", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .send({ model: "gpt-9-turbo", messages: [{ role: "user", content: "hi" }] })
      .expect(409);

    expect(response.body.error.code).toBe("model_disabled");
  });

  it("rejects a Chat Completions resume for an unknown thread", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .send({
        model: "luna",
        messages: [{ role: "user", content: "continue" }],
        aialra: { session_key: "thread-missing" },
      })
      .expect(409);

    expect(response.body.error.code).toBe("session_expired");
  });

  it("lists conversation threads for the caller", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/threads")
      .set("Authorization", `Bearer ${bootstrapKey}`)
      .expect(200);

    expect(Array.isArray(response.body.data)).toBe(true);
  });
});
