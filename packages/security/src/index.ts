import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface EncryptedPayload {
  algorithm: "aes-256-gcm";
  ciphertext: string;
  iv: string;
  tag: string;
  aad?: string;
}

export interface EncryptedRecord {
  version: 1 | 2;
  algorithm: "aes-256-gcm-envelope";
  encryptedDataKey: EncryptedPayload;
  payload: EncryptedPayload;
  aad?: string;
}

export function generateApiKey(): { plaintext: string; prefix: string } {
  const prefix = `amr_${randomBytes(6).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  return { plaintext: `${prefix}_${secret}`, prefix };
}

export function apiKeyPrefix(plaintext: string): string | null {
  const match = /^(amr_[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/.exec(plaintext);
  return match?.[1] ?? null;
}

export function hashApiKey(plaintext: string, pepper: string): string {
  if (pepper.length < 32) {
    throw new Error("api_key_pepper_too_short");
  }

  return createHmac("sha256", pepper).update(plaintext).digest("hex");
}

export function verifyApiKey(plaintext: string, expectedDigest: string, pepper: string): boolean {
  const actual = Buffer.from(hashApiKey(plaintext, pepper), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifySharedSecret(
  actual: string | undefined,
  expected: string | undefined,
): boolean {
  if (!actual || !expected) {
    return false;
  }
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function encryptPayload(
  value: unknown,
  masterKeyBase64: string,
  aad?: string,
): EncryptedPayload {
  const key = Buffer.from(masterKeyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("payload_master_key_must_be_32_bytes");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    algorithm: "aes-256-gcm",
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ...(aad ? { aad } : {}),
  };
}

export function decryptPayload<T>(
  payload: EncryptedPayload,
  masterKeyBase64: string,
  expectedAad?: string,
): T {
  const key = Buffer.from(masterKeyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("payload_master_key_must_be_32_bytes");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  const aad = expectedAad ?? payload.aad;
  if (expectedAad && payload.aad !== expectedAad) throw new Error("encrypted_record_aad_mismatch");
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function encryptRecord(
  value: unknown,
  masterKeyBase64: string,
  aad = "aialra-record:v2",
): EncryptedRecord {
  const dataKey = randomBytes(32).toString("base64");
  return {
    version: 2,
    algorithm: "aes-256-gcm-envelope",
    aad,
    encryptedDataKey: encryptPayload(dataKey, masterKeyBase64, `${aad}:data-key`),
    payload: encryptPayload(value, dataKey, aad),
  };
}

export function decryptRecord<T>(
  record: EncryptedRecord,
  masterKeyBase64: string,
  expectedAad?: string,
): T {
  if (![1, 2].includes(record.version) || record.algorithm !== "aes-256-gcm-envelope") {
    throw new Error("unsupported_encrypted_record");
  }
  if (record.version === 1) {
    const dataKey = decryptPayload<string>(record.encryptedDataKey, masterKeyBase64);
    return decryptPayload<T>(record.payload, dataKey);
  }
  const aad = expectedAad ?? record.aad;
  if (!aad || record.aad !== aad) throw new Error("encrypted_record_aad_mismatch");
  const dataKey = decryptPayload<string>(
    record.encryptedDataKey,
    masterKeyBase64,
    `${aad}:data-key`,
  );
  return decryptPayload<T>(record.payload, dataKey, aad);
}

export function isEncryptedRecord(value: unknown): value is EncryptedRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<EncryptedRecord>;
  return (
    (candidate.version === 1 || candidate.version === 2) &&
    candidate.algorithm === "aes-256-gcm-envelope"
  );
}

const SENSITIVE_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { code: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/i },
  { code: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { code: "codex_auth", pattern: /(?:auth\.json|refresh_token|access_token)/i },
  { code: "windows_path", pattern: /\b[A-Za-z]:\\(?:Users|ProgramData|Windows)\\/i },
  { code: "unix_secret_path", pattern: /\/(?:root|home)\/[^\s]+\/(?:\.ssh|\.codex)\//i },
];

export function scanForExternalData(value: unknown): { allowed: boolean; findings: string[] } {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const findings = SENSITIVE_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ code }) => code,
  );
  return { allowed: findings.length === 0, findings };
}

export function redact(value: string): string {
  return SENSITIVE_PATTERNS.reduce(
    (current, { pattern }) => current.replace(pattern, "[REDACTED]"),
    value,
  );
}
