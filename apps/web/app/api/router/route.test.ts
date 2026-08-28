import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("console API proxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards a verified Authentik identity regardless of the build-time auth mode", async () => {
    vi.resetModules();
    process.env.AUTH_MODE = "passkey";
    delete process.env.EDGE_PROXY_SECRET_FILE;
    delete process.env.INTERNAL_PROXY_SECRET_FILE;
    process.env.EDGE_PROXY_SECRET = "synthetic-edge-proof-000000000000000000000";
    process.env.INTERNAL_PROXY_SECRET = "synthetic-internal-proof-0000000000000000";
    const { GET } = await import("./[...path]/route.js");

    let upstreamHeaders: Headers | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        upstreamHeaders = new Headers(init?.headers);
        return Response.json({ ok: true });
      }),
    );

    const request = new NextRequest("https://router.example.test/api/router/api/v1/quota", {
      headers: {
        "x-aialra-sub": "synthetic-operator",
        "x-aialra-authenticated": "true",
        "x-aialra-edge-proof": process.env.EDGE_PROXY_SECRET,
        "x-aialra-groups": "aialra:access:model-router",
        "x-aialra-auth-time": "2026-08-27T18:00:00.000Z",
      },
    });
    const { trustedAuthentikIdentity } = await import("../../../lib/trusted-authentik.js");
    expect(trustedAuthentikIdentity(request.headers, process.env.EDGE_PROXY_SECRET)?.subject).toBe(
      "synthetic-operator",
    );
    const response = await GET(request, {
      params: Promise.resolve({ path: ["api", "v1", "quota"] }),
    });

    expect(response.status).toBe(200);
    expect(upstreamHeaders?.get("x-aialra-sub")).toBe("synthetic-operator");
    expect(upstreamHeaders?.get("x-aialra-authenticated")).toBe("true");
    expect(upstreamHeaders?.get("x-aialra-groups")).toBe("aialra:access:model-router");
    expect(upstreamHeaders?.get("x-aialra-auth-time")).toBe("2026-08-27T18:00:00.000Z");
    expect(upstreamHeaders?.get("x-aialra-proxy-proof")).toBe(process.env.INTERNAL_PROXY_SECRET);
  });
});
