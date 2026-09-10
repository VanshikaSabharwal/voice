/** Sign out by clearing the session cookie. */

import { cookies } from "next/headers";
import { SESSION_COOKIE } from "../../../../lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);

  return Response.json({ ok: true });
}
