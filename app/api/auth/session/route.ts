/** Who am I? Used by the client shell to render role-appropriate navigation. */

import { getSession } from "../../../../lib/auth/guard";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();

  if (!session) return Response.json({ session: null });

  return Response.json({
    session: {
      userId: session.userId,
      role: session.role,
      name: session.name,
      email: session.email,
    },
  });
}
