import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  apiKeyPrefix,
  decryptPayload,
  decryptRecord,
  encryptPayload,
  encryptRecord,
  generateApiKey,
  hashApiKey,
  scanForExternalData,
  verifyApiKey,
  verifySharedSecret,
} from "../src/index.js";

describe("API keys", () => {
  it("generates and verifies one-way digests", () => {
    const pepper = randomBytes(32).toString("base64url");
    const key = generateApiKey();
    const digest = hashApiKey(key.plaintext, pepper);

    expect(verifyApiKey(key.plaintext, digest, pepper)).toBe(true);
    expect(verifyApiKey(`${key.plaintext}x`, digest, pepper)).toBe(false);
  });

  it("extracts the fixed key prefix even when the secret contains underscores", () => {
    for (let index = 0; index < 1_000; index += 1) {
      const key = generateApiKey();
      expect(apiKeyPrefix(key.plaintext)).toBe(key.prefix);
    }
    expect(apiKeyPrefix("not-a-router-key")).toBeNull();
  });

  it("verifies internal proxy proofs without variable-time string comparison", () => {
    const proof = randomBytes(32).toString("base64url");

    expect(verifySharedSecret(proof, proof)).toBe(true);
    expect(verifySharedSecret(`${proof}x`, proof)).toBe(false);
    expect(verifySharedSecret(undefined, proof)).toBe(false);
  });
});

describe("payload encryption", () => {
  it("round trips structured data", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptPayload({ objective: "safe" }, key);

    expect(decryptPayload(encrypted, key)).toEqual({ objective: "safe" });
  });

  it("uses a separate data key for every encrypted record", () => {
    const key = randomBytes(32).toString("base64");
    const first = encryptRecord({ objective: "safe" }, key);
    const second = encryptRecord({ objective: "safe" }, key);

    expect(first.encryptedDataKey.ciphertext).not.toBe(second.encryptedDataKey.ciphertext);
    expect(decryptRecord(first, key)).toEqual({ objective: "safe" });
  });

  it("rejects a record moved to another job field", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptRecord({ objective: "safe" }, key, "job:one:task:v2");

    expect(() => decryptRecord(encrypted, key, "job:two:task:v2")).toThrow(
      "encrypted_record_aad_mismatch",
    );
  });
});

describe("external data scanner", () => {
  it("rejects private key material", () => {
    const syntheticPrivateKey = ["-----BEGIN", "PRIVATE", "KEY-----", "secret"].join(" ");

    expect(scanForExternalData(syntheticPrivateKey).allowed).toBe(false);
  });
});
