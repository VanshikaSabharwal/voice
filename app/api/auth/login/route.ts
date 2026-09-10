/**
 * Sign in. Seeds the default admin on first use so a fresh install has a way in.
 */

import { cookies } from "next/headers";
import { COOKIE_OPTIONS, SESSION_COOKIE, encodeSession } from "../../../../lib/auth/session";
import { verifyPassword } from "../../../../lib/auth/password";
import { homeFor } from "../../../../lib/auth/guard";
import { findUserByEmail, seedAdmin, toSafeUser } from "../../../../lib/store/reading";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { email?: string; password?: string };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { email, password } = body;

  if (!email || !password) {
    return Response.json(
      { error: "Email and password are required." },
      { status: 400 },
    );
  }

  /* Seeding here rather than at module load keeps `next build` from needing a
     reachable database. It is a no-op once an admin exists. */
  try {
    await seedAdmin();
  } catch (err) {
    console.error("[login] seed failed:", err);
  }

  const user = await findUserByEmail(email);

  /* One message for both "no such user" and "wrong password" so the form
     cannot be used to discover which emails are registered. */
  const invalid = Response.json(
    { error: "Incorrect email or password." },
    { status: 401 },
  );

  if (!user) return invalid;
  if (!(await verifyPassword(password, user.passwordHash))) return invalid;

  const store = await cookies();

  store.set(
    SESSION_COOKIE,
    encodeSession({
      userId: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
    }),
    COOKIE_OPTIONS,
  );

  return Response.json({ user: toSafeUser(user), redirect: homeFor(user.role) });
}
