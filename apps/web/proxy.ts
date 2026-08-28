import { NextResponse, type NextRequest } from "next/server";

import { trustedAuthentikIdentity } from "./lib/trusted-authentik";

function contentSecurityPolicy(nonce: string): string {
  const development = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  let response: NextResponse;
  const localBypass =
    process.env["LOCAL_UI_BYPASS"] === "true" &&
    (request.nextUrl.hostname === "127.0.0.1" || request.nextUrl.hostname === "localhost");
  if (request.nextUrl.pathname.startsWith("/console")) {
    if (localBypass || trustedAuthentikIdentity(request.headers)) {
      response = NextResponse.next({ request: { headers: requestHeaders } });
    } else if (process.env["AUTH_MODE"] === "authentik") {
      const signIn = new URL("/_aialra_auth/sign-in", request.url);
      signIn.searchParams.set("return", request.nextUrl.pathname);
      response = NextResponse.redirect(signIn);
    } else if (!request.cookies.has("amr_session")) {
      const login = new URL("/login", request.url);
      login.searchParams.set("returnTo", request.nextUrl.pathname);
      response = NextResponse.redirect(login);
    } else {
      response = NextResponse.next({ request: { headers: requestHeaders } });
    }
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|openapi|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
