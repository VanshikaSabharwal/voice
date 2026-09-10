/**
 * User management. Admin-only: creating teachers and students is an admin
 * responsibility, and teachers may only read the students assigned to them.
 */

import { guarded, requireRole } from "../../../lib/auth/guard";
import { hashPassword } from "../../../lib/auth/password";
import {
  findUserByEmail,
  newId,
  normalizeEmail,
  toSafeUser,
  users,
  deleteUserCascade,
} from "../../../lib/store/reading";
import type { Role, User } from "../../../lib/reading/types";

export const dynamic = "force-dynamic";

const ROLES: Role[] = ["admin", "teacher", "student"];

export const GET = guarded(async (request: Request) => {
  const session = await requireRole("admin", "teacher");
  const role = new URL(request.url).searchParams.get("role");

  const filter: Partial<User> = {};
  if (role && ROLES.includes(role as Role)) filter.role = role as Role;

  let list = await users.list(filter);

  /* A teacher may only see their own students. Without this narrowing the
     roster endpoint would expose every child in the school to every teacher. */
  if (session.role === "teacher") {
    list = list.filter(
      (user) => user.role === "student" && user.teacherId === session.userId,
    );
  }

  return Response.json({
    users: list
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(toSafeUser),
  });
});

export const POST = guarded(async (request: Request) => {
  await requireRole("admin");

  let body: {
    role?: Role;
    name?: string;
    email?: string;
    password?: string;
    teacherId?: string;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { role, name, email, password, teacherId } = body;

  if (!role || !ROLES.includes(role)) {
    return Response.json({ error: "A valid role is required." }, { status: 400 });
  }

  if (!name?.trim() || !email?.trim() || !password) {
    return Response.json(
      { error: "Name, email and password are required." },
      { status: 400 },
    );
  }

  if (password.length < 6) {
    return Response.json(
      { error: "Password must be at least 6 characters." },
      { status: 400 },
    );
  }

  if (await findUserByEmail(email)) {
    return Response.json(
      { error: "An account with that email already exists." },
      { status: 409 },
    );
  }

  const user: User = {
    id: newId(),
    role,
    name: name.trim(),
    email: normalizeEmail(email),
    passwordHash: await hashPassword(password),
    // Only meaningful for students; storing it on a teacher would be noise.
    teacherId: role === "student" ? teacherId : undefined,
    createdAt: Date.now(),
  };

  if (!(await users.put(user))) {
    return Response.json(
      { error: "Could not save the account. Storage is not writable." },
      { status: 500 },
    );
  }

  return Response.json({ user: toSafeUser(user) });
});

export const PATCH = guarded(async (request: Request) => {
  await requireRole("admin");

  let body: {
    id?: string;
    name?: string;
    email?: string;
    password?: string;
    teacherId?: string | null;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { id, name, email, password, teacherId } = body;

  if (!id) return Response.json({ error: "id is required." }, { status: 400 });

  const existing = await users.get(id);
  if (!existing) return Response.json({ error: "No such user." }, { status: 404 });

  const changes: Partial<User> = {};

  if (name?.trim()) changes.name = name.trim();

  if (email?.trim()) {
    const next = normalizeEmail(email);
    const clash = await findUserByEmail(next);

    if (clash && clash.id !== id) {
      return Response.json(
        { error: "Another account already uses that email." },
        { status: 409 },
      );
    }

    changes.email = next;
  }

  if (password) {
    if (password.length < 6) {
      return Response.json(
        { error: "Password must be at least 6 characters." },
        { status: 400 },
      );
    }
    changes.passwordHash = await hashPassword(password);
  }

  // null explicitly unlinks a student from their teacher; undefined leaves it.
  if (teacherId !== undefined) {
    changes.teacherId = teacherId ?? undefined;
  }

  const updated = await users.patch(id, changes);

  if (!updated) {
    return Response.json({ error: "Could not update the account." }, { status: 500 });
  }

  return Response.json({ user: toSafeUser(updated) });
});

export const DELETE = guarded(async (request: Request) => {
  const session = await requireRole("admin");
  const id = new URL(request.url).searchParams.get("id");

  if (!id) return Response.json({ error: "id is required." }, { status: 400 });

  // Deleting yourself would lock the last admin out of the installation.
  if (id === session.userId) {
    return Response.json(
      { error: "You cannot delete your own account." },
      { status: 409 },
    );
  }

  await deleteUserCascade(id);

  return Response.json({ ok: true });
});
