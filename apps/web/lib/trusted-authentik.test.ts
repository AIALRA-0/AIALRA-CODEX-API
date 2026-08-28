import { describe, expect, it } from "vitest";

import { trustedAuthentikIdentity } from "./trusted-authentik.js";

describe("trustedAuthentikIdentity", () => {
  it("accepts identity only with the edge proof", () => {
    const headers = new Headers({
      "x-aialra-sub": "operator@example.test",
      "x-aialra-authenticated": "true",
      "x-aialra-edge-proof": "edge-secret",
      "x-aialra-groups": "aialra:access:model-router",
      "x-aialra-auth-time": "2026-08-27T18:00:00.000Z",
    });
    expect(trustedAuthentikIdentity(headers, "edge-secret")?.subject).toBe("operator@example.test");
  });

  it("rejects spoofed local identity headers", () => {
    const headers = new Headers({
      "x-aialra-sub": "attacker@example.test",
      "x-aialra-authenticated": "true",
    });
    expect(trustedAuthentikIdentity(headers, "edge-secret")).toBeNull();
  });

  it("rejects an explicit false authentication marker", () => {
    const headers = new Headers({
      "x-aialra-sub": "attacker@example.test",
      "x-aialra-authenticated": "false",
      "x-aialra-edge-proof": "edge-secret",
      "x-aialra-groups": "aialra:access:model-router",
      "x-aialra-auth-time": "2026-08-27T18:00:00.000Z",
    });
    expect(trustedAuthentikIdentity(headers, "edge-secret")).toBeNull();
  });
});
