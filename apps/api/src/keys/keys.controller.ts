import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { ExecutionPolicySchema, type ExecutionPolicy } from "@aialra/contracts";
import type { JobRepository, StoredApiKey } from "@aialra/persistence";
import { generateApiKey, hashApiKey, requestHash } from "@aialra/security";

import { PublicRoute } from "../common/public.decorator.js";
import type { AuthenticatedRequest } from "../common/api-key.guard.js";
import { RequireScopes } from "../common/scopes.decorator.js";
import { JOB_REPOSITORY } from "../tokens.js";

const CreateKeySchema = z
  .object({
    name: z.string().min(1).max(100),
    scopes: z
      .array(
        z.enum([
          "admin",
          "jobs:read",
          "jobs:write",
          "quota:read",
          "keys:write",
          "approvals:write",
          "chatgpt:web",
        ]),
      )
      .min(1),
    rateLimitPerMinute: z.number().int().min(1).max(10_000).default(60),
    expiresAt: z.string().datetime().nullable().optional(),
    executionPolicy: ExecutionPolicySchema.default({
      defaultPreset: "restricted",
      allowedPresets: ["restricted"],
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.scopes).size !== value.scopes.length) {
      context.addIssue({ code: "custom", path: ["scopes"], message: "Scopes must be unique." });
    }
    if (value.expiresAt && Date.parse(value.expiresAt) <= Date.now()) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Expiration must be in the future.",
      });
    }
  });

const RevokeKeySchema = z.object({ confirmationPrefix: z.string().min(1) }).strict();

@Controller("api/v1")
export class KeysController {
  constructor(@Inject(JOB_REPOSITORY) private readonly repository: JobRepository) {}

  private async createRecord(
    body: unknown,
    actorId: string,
    options: {
      idempotencyKey?: string;
      actorScopes: string[];
      actorExecutionPolicy: ExecutionPolicy;
      isAdmin: boolean;
      recentAuthentication: boolean;
    },
  ) {
    const parsed = CreateKeySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: {
          code: "invalid_request",
          message: "The API key request is invalid.",
          details: parsed.error.flatten(),
        },
      });
    }
    const input = parsed.data;
    if (input.scopes.includes("admin") && !options.isAdmin) {
      throw new ForbiddenException({
        error: {
          code: "admin_scope_requires_admin",
          message: "Only an administrator can grant admin.",
        },
      });
    }
    if (!options.isAdmin && input.scopes.some((scope) => !options.actorScopes.includes(scope))) {
      throw new ForbiddenException({
        error: {
          code: "scope_escalation_denied",
          message: "A key cannot grant scopes its creator lacks.",
        },
      });
    }
    if (
      input.executionPolicy.allowedPresets.some(
        (preset) => !options.actorExecutionPolicy.allowedPresets.includes(preset),
      )
    ) {
      throw new ForbiddenException({
        error: {
          code: "permission_ceiling_exceeded",
          message: "新密钥的执行权限不能超过创建者自己的权限上限。",
        },
      });
    }
    if (
      input.executionPolicy.allowedPresets.includes("full") &&
      (!options.isAdmin || !options.recentAuthentication)
    ) {
      throw new ForbiddenException({
        error: {
          code: "recent_authentication_required",
          message: "授予可信 Agent 隔离区完全访问需要管理员在五分钟内重新认证。",
        },
      });
    }
    if (input.expiresAt === null && !options.isAdmin) {
      throw new ForbiddenException({
        error: {
          code: "non_expiring_key_requires_admin",
          message: "Only an administrator can create a non-expiring key.",
        },
      });
    }
    const pepper = process.env.API_KEY_PEPPER;
    if (!pepper) {
      throw new BadRequestException({
        error: { code: "authentication_not_configured", message: "API_KEY_PEPPER is required." },
      });
    }
    const generated = generateApiKey();
    const record: StoredApiKey = {
      id: randomUUID(),
      createdBy: actorId,
      name: input.name,
      prefix: generated.prefix,
      digest: hashApiKey(generated.plaintext, pepper),
      scopes: input.scopes,
      executionPolicy: input.executionPolicy,
      rateLimitPerMinute: input.rateLimitPerMinute,
      expiresAt:
        input.expiresAt === undefined
          ? new Date(Date.now() + 30 * 86_400_000).toISOString()
          : input.expiresAt,
      revokedAt: null,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    let saved = { record, plaintext: generated.plaintext, replayed: false };
    if (options.idempotencyKey) {
      try {
        saved = await this.repository.createApiKeyIdempotent(
          actorId,
          options.idempotencyKey,
          requestHash(input),
          record,
          generated.plaintext,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "idempotency_conflict") {
          throw new ConflictException({
            error: {
              code: "idempotency_conflict",
              message: "This idempotency key was used for another request.",
            },
          });
        }
        throw error;
      }
    } else {
      await this.repository.createApiKey(record);
    }
    await this.repository.appendAudit({
      id: randomUUID(),
      actorId,
      action: "api_key.created",
      resourceType: "api_key",
      resourceId: saved.record.id,
      metadata: {
        prefix: saved.record.prefix,
        scopes: saved.record.scopes,
        executionPolicy: saved.record.executionPolicy,
        replayed: saved.replayed,
      },
      createdAt: new Date().toISOString(),
    });
    return {
      id: saved.record.id,
      name: saved.record.name,
      prefix: saved.record.prefix,
      scopes: saved.record.scopes,
      executionPolicy: saved.record.executionPolicy,
      rateLimitPerMinute: saved.record.rateLimitPerMinute,
      expiresAt: saved.record.expiresAt,
      revokedAt: saved.record.revokedAt,
      createdAt: saved.record.createdAt,
      lastUsedAt: saved.record.lastUsedAt,
      key: saved.plaintext,
      replayed: saved.replayed,
    };
  }

  @PublicRoute()
  @Post("bootstrap/keys")
  async bootstrap(@Body() body: unknown, @Headers("x-bootstrap-token") bootstrapToken?: string) {
    const expected = process.env.BOOTSTRAP_ADMIN_TOKEN;
    if (!expected || bootstrapToken !== expected || (await this.repository.apiKeyCount()) > 0) {
      throw new UnauthorizedException({
        error: { code: "bootstrap_unavailable", message: "Bootstrap is unavailable." },
      });
    }
    return this.createRecord(
      {
        ...((body ?? {}) as object),
        name: "Bootstrap administrator",
        scopes: ["admin"],
        executionPolicy: {
          defaultPreset: "full",
          allowedPresets: ["restricted", "confirm", "full"],
        },
      },
      "bootstrap",
      {
        actorScopes: ["admin"],
        actorExecutionPolicy: {
          defaultPreset: "full",
          allowedPresets: ["restricted", "confirm", "full"],
        },
        isAdmin: true,
        recentAuthentication: true,
      },
    );
  }

  @RequireScopes("keys:write")
  @Post("keys")
  async create(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: { code: "idempotency_key_required", message: "Idempotency-Key is required." },
      });
    }
    const recentAuthentication =
      request.authenticatedAt && Date.now() - Date.parse(request.authenticatedAt) <= 5 * 60_000;
    const requestedScopes = (body as { scopes?: unknown })?.scopes;
    if (
      Array.isArray(requestedScopes) &&
      requestedScopes.includes("admin") &&
      !recentAuthentication
    ) {
      throw new ForbiddenException({
        error: {
          code: "recent_authentication_required",
          message: "Recent administrator authentication is required.",
        },
      });
    }
    return this.createRecord(body, request.callerId ?? "unknown", {
      idempotencyKey,
      actorScopes: request.scopes ?? [],
      actorExecutionPolicy: request.executionPolicy ?? {
        defaultPreset: "restricted",
        allowedPresets: ["restricted"],
      },
      isAdmin: request.isAdmin === true,
      recentAuthentication: recentAuthentication === true,
    });
  }

  @RequireScopes("keys:write")
  @Get("keys")
  async list(@Req() request: AuthenticatedRequest) {
    return {
      data: await this.repository.listApiKeysForActor(
        request.callerId ?? "unknown",
        request.isAdmin === true,
      ),
    };
  }

  @RequireScopes("keys:write")
  @Post("keys/:id/revoke")
  async revoke(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: { code: "idempotency_key_required", message: "Idempotency-Key is required." },
      });
    }
    const parsed = RevokeKeySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: { code: "invalid_request", message: "A confirmation prefix is required." },
      });
    }
    const record = await this.repository.findApiKeyById(id);
    if (!record) {
      throw new NotFoundException({
        error: { code: "api_key_not_found", message: "The API key does not exist." },
      });
    }
    if (request.isAdmin !== true && record.createdBy !== request.callerId) {
      throw new ForbiddenException({
        error: { code: "api_key_access_denied", message: "You cannot manage this API key." },
      });
    }
    if (record.prefix !== parsed.data.confirmationPrefix) {
      throw new BadRequestException({
        error: {
          code: "confirmation_mismatch",
          message: "The confirmation prefix does not match.",
        },
      });
    }
    if (record.revokedAt) return { id, revoked: true, alreadyRevoked: true };
    if (record.scopes.includes("admin")) {
      const recentAuthentication =
        request.authenticatedAt && Date.now() - Date.parse(request.authenticatedAt) <= 5 * 60_000;
      if (request.isAdmin !== true || !recentAuthentication) {
        throw new ForbiddenException({
          error: {
            code: "admin_reauthentication_required",
            message: "Administrator verification is required.",
          },
        });
      }
      if ((await this.repository.activeAdminApiKeyCount()) <= 1) {
        throw new ConflictException({
          error: {
            code: "last_admin_key",
            message: "The last administrator key cannot be revoked.",
          },
        });
      }
    }
    await this.repository.revokeApiKey(id);
    await this.repository.appendAudit({
      id: randomUUID(),
      actorId: request.callerId ?? "unknown",
      action: "api_key.revoked",
      resourceType: "api_key",
      resourceId: id,
      metadata: {},
      createdAt: new Date().toISOString(),
    });
    return { id, revoked: true, alreadyRevoked: false };
  }
}
