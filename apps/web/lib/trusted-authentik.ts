import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export interface TrustedAuthentikIdentity {
  subject: string;
  authenticated: string;
  groups: string;
  authTime: string;
}

let cachedEdgeSecret: string | null = null;

function edgeProxySecret(): string | null {
  if (cachedEdgeSecret) {
    return cachedEdgeSecret;
  }
  const secretFile = process.env.EDGE_PROXY_SECRET_FILE;
  if (secretFile && existsSync(secretFile)) {
    cachedEdgeSecret = readFileSync(secretFile, "utf8").trim();
    return cachedEdgeSecret;
  }
  cachedEdgeSecret = process.env.EDGE_PROXY_SECRET?.trim() || null;
  return cachedEdgeSecret;
}

function matches(actual: string | null, expected: string | null): boolean {
  if (!actual || !expected) {
    return false;
  }
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function trustedAuthentikIdentity(
  headers: Headers,
  expectedSecret: string | null = edgeProxySecret(),
): TrustedAuthentikIdentity | null {
  const subject = headers.get("x-aialra-sub")?.trim();
  const authenticated = headers.get("x-aialra-authenticated")?.trim();
  const proof = headers.get("x-aialra-edge-proof");
  const groups = headers.get("x-aialra-groups")?.trim();
  const authTime = headers.get("x-aialra-auth-time")?.trim();
  if (
    !subject ||
    (authenticated !== "true" && authenticated !== "1") ||
    !groups ||
    !authTime ||
    !Number.isFinite(Date.parse(authTime)) ||
    !matches(proof, expectedSecret)
  ) {
    return null;
  }
  return { subject, authenticated, groups, authTime };
}
