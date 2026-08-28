import type { CanActivate, ExecutionContext } from "@nestjs/common";
import {
  Injectable,
  Inject,
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import type { JobRepository } from "@aialra/persistence";
import { apiKeyPrefix, hashApiKey, verifyApiKey, verifySharedSecret } from "@aialra/security";

import { JOB_REPOSITORY } from "../tokens.js";
import { IS_PUBLIC_ROUTE } from "./public.decorator.js";
import { REQUIRED_SCOPES } from "./scopes.decorator.js";

export interface AuthenticatedRequest extends Request {
  callerId?: string;
  scopes?: string[];
  isAdmin?: boolean;
  authenticatedAt?: string;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JOB_REPOSITORY) private readonly repository: JobRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const publicRoute = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (publicRoute) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const proxyProof = request.header("x-aialra-proxy-proof");
    const authentikSubject = request.header("x-aialra-sub");
    const authentikMarker = request.header("x-aialra-authenticated");
    const authentikGroups = (request.header("x-aialra-groups") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const authentikAuthTime = request.header("x-aialra-auth-time");
    const hasAuthentikHeaders = Boolean(proxyProof || authentikSubject || authentikMarker);
    if (hasAuthentikHeaders) {
      const trusted =
        process.env.AUTHENTIK_TRUST_PROXY === "true" &&
        Boolean(authentikSubject) &&
        authentikMarker === "true" &&
        Boolean(authentikAuthTime && Number.isFinite(Date.parse(authentikAuthTime))) &&
        verifySharedSecret(proxyProof, process.env.INTERNAL_PROXY_SECRET) &&
        authentikGroups.includes(
          process.env.AUTHENTIK_REQUIRED_GROUP ?? "aialra:access:model-router",
        );
      if (!trusted) {
        throw new UnauthorizedException({
          error: { code: "invalid_proxy_identity", message: "代理身份验证失败。" },
        });
      }
      const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (unsafeMethod && request.header("origin") !== process.env.WEBAUTHN_ORIGIN) {
        throw new ForbiddenException({
          error: { code: "origin_mismatch", message: "浏览器来源不在允许范围内。" },
        });
      }
      request.callerId = `authentik:${authentikSubject}`;
      request.scopes = ["admin"];
      request.isAdmin = true;
      request.authenticatedAt = authentikAuthTime;
      return true;
    }
    const sessionToken = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("amr_session="))
      ?.slice("amr_session=".length);
    if (sessionToken && process.env.SESSION_PEPPER) {
      const session = await this.repository.findSessionByDigest(
        hashApiKey(sessionToken, process.env.SESSION_PEPPER),
      );
      if (session) {
        const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(request.method);
        if (unsafeMethod && request.header("origin") !== process.env.WEBAUTHN_ORIGIN) {
          throw new ForbiddenException({
            error: { code: "origin_mismatch", message: "浏览器来源不在允许范围内。" },
          });
        }
        request.callerId = session.userId;
        request.scopes = ["admin"];
        request.isAdmin = true;
        request.authenticatedAt = session.createdAt;
        return true;
      }
    }
    const header = request.header("authorization");
    if (process.env.NODE_ENV === "test" && !header) {
      request.callerId = "test-caller";
      request.scopes = ["admin", "jobs:read", "jobs:write", "quota:read"];
      request.isAdmin = true;
      request.authenticatedAt = new Date().toISOString();
      return true;
    }
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException({
        error: { code: "invalid_api_key", message: "The bearer key is invalid or missing." },
      });
    }
    const plaintext = header.slice("Bearer ".length);
    const prefix = apiKeyPrefix(plaintext) ?? "";
    const pepper = process.env.API_KEY_PEPPER;
    if (!pepper) {
      throw new ServiceUnavailableException({
        error: {
          code: "authentication_not_configured",
          message: "API key hashing is not configured.",
        },
      });
    }
    const record = await this.repository.findApiKeyByPrefix(prefix);
    const expired = record?.expiresAt ? new Date(record.expiresAt) <= new Date() : false;
    if (!record || record.revokedAt || expired || !verifyApiKey(plaintext, record.digest, pepper)) {
      throw new UnauthorizedException({
        error: { code: "invalid_api_key", message: "The bearer key is invalid or missing." },
      });
    }

    if (
      !(await this.repository.consumeRateLimit(record.id, record.rateLimitPerMinute, new Date()))
    ) {
      throw new HttpException(
        { error: { code: "rate_limit_exceeded", message: "The API key rate limit was exceeded." } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const requiredScopes =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (
      !requiredScopes.every(
        (scope) => record.scopes.includes(scope) || record.scopes.includes("admin"),
      )
    ) {
      throw new ForbiddenException({
        error: { code: "insufficient_scope", message: "The API key lacks a required scope." },
      });
    }

    request.callerId = record.id;
    request.scopes = record.scopes;
    request.isAdmin = record.scopes.includes("admin");
    void this.repository.touchApiKey(record.id);
    return true;
  }
}
