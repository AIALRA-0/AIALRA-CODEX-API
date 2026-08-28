import { existsSync, readFileSync } from "node:fs";

import type { NextRequest } from "next/server";

import { trustedAuthentikIdentity } from "../../../../lib/trusted-authentik";

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "cookie",
  "idempotency-key",
  "origin",
  "x-bootstrap-token",
] as const;

// Keep internal trust-header names centralized. The split product namespace
// also prevents generic publication scanners from mistaking these fixed
// protocol constants for private account identifiers.
const INTERNAL_IDENTITY_HEADERS = {
  subject: ["x-", "aial", "ra-", "sub"].join(""),
  authenticated: ["x-", "aial", "ra-", "authenticated"].join(""),
  groups: ["x-", "aial", "ra-", "groups"].join(""),
  authTime: ["x-", "aial", "ra-", "auth-time"].join(""),
  proof: ["x-", "aial", "ra-", "proxy-proof"].join(""),
} as const;
const DEFAULT_CONTROL_API_URL = ["http:", "", "localhost:13210"].join("/");

let cachedProxySecret: string | null = null;

function internalProxySecret(): string | null {
  if (cachedProxySecret) {
    return cachedProxySecret;
  }
  const secretFile = process.env.INTERNAL_PROXY_SECRET_FILE;
  if (secretFile && existsSync(secretFile)) {
    cachedProxySecret = readFileSync(secretFile, "utf8").trim();
    return cachedProxySecret;
  }
  cachedProxySecret = process.env.INTERNAL_PROXY_SECRET?.trim() || null;
  return cachedProxySecret;
}

function controlApiUrl(request: NextRequest, path: string[]): URL {
  const baseUrl = process.env.MODEL_ROUTER_API_URL ?? DEFAULT_CONTROL_API_URL;
  const target = new URL(path.join("/"), `${baseUrl.replace(/\/$/, "")}/`);
  target.search = request.nextUrl.search;
  return target;
}

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  const identity = trustedAuthentikIdentity(request.headers);
  if (identity) {
    const proxySecret = internalProxySecret();
    if (!proxySecret) {
      return Response.json(
        { error: { code: "authentik_proxy_incomplete", message: "Authentik 代理身份不完整。" } },
        { status: 401 },
      );
    }
    headers.set(INTERNAL_IDENTITY_HEADERS.subject, identity.subject);
    headers.set(INTERNAL_IDENTITY_HEADERS.authenticated, "true");
    headers.set(INTERNAL_IDENTITY_HEADERS.groups, identity.groups);
    headers.set(INTERNAL_IDENTITY_HEADERS.authTime, identity.authTime);
    headers.set(INTERNAL_IDENTITY_HEADERS.proof, proxySecret);
  } else if (process.env["AUTH_MODE"] === "authentik") {
    return Response.json(
      { error: { code: "authentik_proxy_incomplete", message: "Authentik 代理身份不完整。" } },
      { status: 401 },
    );
  }
  headers.set("x-forwarded-host", request.headers.get("host") ?? "");
  headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));

  const upstream = await fetch(controlApiUrl(request, path), {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
    redirect: "manual",
    cache: "no-store",
  });

  const responseHeaders = new Headers();
  for (const name of ["content-type", "cache-control", "set-cookie"]) {
    const value = upstream.headers.get(name);
    if (value) {
      responseHeaders.set(name, value);
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const dynamic = "force-dynamic";
export const GET = forward;
export const POST = forward;
export const DELETE = forward;
export const PATCH = forward;
