/**
 * Route protection.
 *
 * `middleware.ts` was deprecated in Next 16 and renamed to `proxy.ts`; the
 * exported function is `proxy`. Proxy runs on the Node.js runtime by default
 * here, so node:crypto — and therefore signature verification — works.
 *
 * This layer only redirects. Authorization is enforced again inside every
 * route handler and server page via lib/auth/guard.ts, because a matcher
 * change or a moved route silently removes proxy coverage and the Next docs
 * warn against relying on it as the security boundary.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, decodeSession } from "./lib/auth/session";
import { homeFor } from "./lib/auth/guard";
import type { Role } from "./lib/reading/types";

/** Path prefix -> roles allowed to see it. */
const PROTECTED: { prefix: string; roles: Role[] }[] = [
  { prefix: "/admin", roles: ["admin"] },
  { prefix: "/teacher", roles: ["teacher"] },
  { prefix: "/student", roles: ["student"] },
  /* The original voice playground and its settings are an operator tool. It
     lives at /playground rather than / because / redirects every role to its
     own landing page, which would make the harness unreachable. */
  { prefix: "/settings", roles: ["admin"] },
  { prefix: "/conversations", roles: ["admin"] },
  { prefix: "/playground", roles: ["admin"] },
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const session = decodeSession(request.cookies.get(SESSION_COOKIE)?.value);

  // Signed-in users have no reason to see the login form.
  if (pathname === "/login") {
    if (session) {
      return NextResponse.redirect(new URL(homeFor(session.role), request.url));
    }
    return NextResponse.next();
  }

  // Send everyone from the root to wherever their role belongs.
  if (pathname === "/") {
    return NextResponse.redirect(
      new URL(session ? homeFor(session.role) : "/login", request.url),
    );
  }

  const rule = PROTECTED.find(
    (entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`),
  );

  if (!rule) return NextResponse.next();

  if (!session) {
    // Preserve where they were going so login can return them there.
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }

  if (!rule.roles.includes(session.role)) {
    return NextResponse.redirect(new URL(homeFor(session.role), request.url));
  }

  return NextResponse.next();
}

export const config = {
  /* Static assets and API routes are excluded: API routes do their own
     role checks and return JSON, so redirecting them to an HTML login page
     would turn a 401 into an unparseable response for the caller. */
  matcher: ["/((?!api|_next/static|_next/image|uploads|favicon.ico|.*\\.).*)"],
};
