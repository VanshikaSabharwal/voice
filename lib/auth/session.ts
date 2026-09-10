/**
 * Signed session cookies.
 *
 * The session is a signed payload rather than a database-backed session id:
 * proxy.ts checks it on every request, and a database round trip there would
 * put Mongo latency in front of every page load. The tradeoff is that a
 * session cannot be revoked server-side before it expires — acceptable for a
 * short-lived classroom tool, and the reason the TTL is a week rather than
 * months.
 *
 * HMAC-SHA256 over the payload with a secret; tampering with the role inside
 * the cookie invalidates the signature.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "../reading/types";

export const SESSION_COOKIE = "reading_session";

const MAX_AGE_SEC = 7 * 24 * 60 * 60;

export type Session = {
  userId: string;
  role: Role;
  name: string;
  email: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
};

/**
 * The signing secret.
 *
 * Falls back to a fixed development value so `npm run dev` works with no
 * setup, exactly as MONGODB_URL is optional elsewhere in this project. In
 * production an unset secret would mean every deployment could forge every
 * other one's cookies, so it is required there.
 */
function secret(): string {
  const configured = process.env.SESSION_SECRET?.trim();

  if (configured) return configured;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is not set. Generate one with `openssl rand -hex 32`.",
    );
  }

  return "dev-only-insecure-session-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Encode and sign a session into a cookie value. */
export function encodeSession(
  session: Omit<Session, "exp"> & { exp?: number },
): string {
  const full: Session = {
    ...session,
    exp: session.exp ?? Date.now() + MAX_AGE_SEC * 1000,
  };

  const payload = Buffer.from(JSON.stringify(full)).toString("base64url");

  return `${payload}.${sign(payload)}`;
}

/** Verify and decode a cookie value. Returns null if invalid or expired. */
export function decodeSession(value: string | undefined): Session | null {
  if (!value) return null;

  const dot = value.lastIndexOf(".");
  if (dot === -1) return null;

  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);

  // Lengths must match before timingSafeEqual, which throws on a mismatch.
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  let session: Session;

  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof session.exp !== "number" || session.exp < Date.now()) return null;

  return session;
}

/** Cookie options shared by the login and logout routes. */
export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: MAX_AGE_SEC,
  secure: process.env.NODE_ENV === "production",
};
