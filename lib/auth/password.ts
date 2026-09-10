/**
 * Password hashing with scrypt from node:crypto.
 *
 * No dependency is added for this: scrypt is memory-hard, is what Node ships
 * for exactly this purpose, and the alternative (bcrypt/argon2) would pull a
 * native module into a project that currently builds with none.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/** Hash a password. Returns `salt:key`, both hex. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `${salt}:${derived.toString("hex")}`;
}

/**
 * Check a password against a stored hash.
 *
 * Compared with timingSafeEqual rather than `===` so the comparison does not
 * leak how much of the hash matched.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [salt, key] = stored.split(":");

  if (!salt || !key) return false;

  const expected = Buffer.from(key, "hex");

  if (expected.length !== KEY_LENGTH) return false;

  const derived = await scryptAsync(password, salt, KEY_LENGTH);

  return timingSafeEqual(derived, expected);
}
