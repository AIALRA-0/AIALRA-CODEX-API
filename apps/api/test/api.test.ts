import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";

describe("AIALRA Model Router API", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTHENTIK_TRUST_PROXY = "true";
    process.env.INTERNAL_PROXY_SECRET = "synthetic-internal-proxy-secret-000000000000";
    process.env.API_KEY_PEPPER = "synthetic-api-key-pepper-with-more-than-32-bytes";
    process.env.BOOTSTRAP_ADMIN_TOKEN = "synthetic-bootstrap-token";
    process.env.WEBAUTHN_ORIGIN = "https://router.example.com";
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
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
  });

  it("previews Luna for bounded work", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/routes/preview")
      .send({ objective: "Extract fields", taskKind: "bounded" })
      .expect(201);

    expect(response.body.model).toBe("gpt-5.6-luna");
  });

  it("rejects unsupported Responses parameters", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/responses")
      .send({ model: "auto", input: "hello", temperature: 0.2 })
      .expect(400);

    expect(response.body.error.code).toBe("unsupported_parameter");
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

  it("uses a newly bootstrapped API key on an authenticated endpoint", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/bootstrap/keys")
      .set("X-Bootstrap-Token", process.env.BOOTSTRAP_ADMIN_TOKEN!)
      .send({})
      .expect(201);

    const response = await request(app.getHttpServer())
      .get("/api/v1/quota")
      .set("Authorization", `Bearer ${created.body.key}`)
      .expect(200);
    expect(response.body.provider).toBe("codex");
  });
});
