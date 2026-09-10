/**
 * Server-side authentication and authorization.
 *
 * proxy.ts redirects unauthenticated browsers, but the Next docs are explicit
 * that proxy alone must not be the authorization boundary — a matcher change
 * or a moved route silently removes its coverage. So every route handler and
 * every server page calls into here as well. Proxy is for redirects; this is
 * for access control.
 */

import { cookies } from "next/headers";
import { SESSION_COOKIE, decodeSession, type Session } from "./session";
import type { Role } from "../reading/types";

/** The current session, or null. `cookies()` is async in Next 16. */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}

/** Thrown by the require* helpers; turned into a response by `guarded`. */
export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();

  if (!session) throw new AuthError(401, "Not signed in.");

  return session;
}

/** Require one of the given roles. Admins are NOT implicitly granted others. */
export async function requireRole(...roles: Role[]): Promise<Session> {
  const session = await requireSession();

  if (!roles.includes(session.role)) {
    throw new AuthError(403, "You do not have access to this.");
  }

  return session;
}

/**
 * Wrap a route handler so an AuthError becomes a proper JSON response
 * instead of an unhandled 500.
 */
export function guarded<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof AuthError) {
        return Response.json({ error: err.message }, { status: err.status });
      }

      console.error("[api] unhandled error:", err);
      return Response.json({ error: "Something went wrong." }, { status: 500 });
    }
  };
}

/** Landing route for each role, used after login and by proxy redirects. */
export function homeFor(role: Role): string {
  if (role === "admin") return "/admin";
  if (role === "teacher") return "/teacher";
  return "/student";
}
