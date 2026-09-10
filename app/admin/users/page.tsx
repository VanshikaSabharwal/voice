"use client";

/**
 * Creating teachers and students. Admin-only, matching the rule that only an
 * admin adds accounts and only a teacher assigns work.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Banner, Button, Card, Dropdown, Empty, Input, PageHeader,
} from "../../components/ui";
import { TrashIcon } from "../../components/Icons";
import type { Role, SafeUser } from "../../../lib/reading/types";

export default function UsersPage() {
  const [list, setList] = useState<SafeUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [role, setRole] = useState<Role>("student");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [teacherId, setTeacherId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/users");
      const data = await res.json();

      if (!res.ok) setError(data.error ?? "Could not load accounts.");
      else setList(data.users);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    /* Deferred to a microtask so the fetch is kicked off after render
       rather than synchronously inside the effect body, which would
       cascade renders. */
    const id = setTimeout(load, 0);
    return () => clearTimeout(id);
  }, [load]);

  const teachers = list.filter((user) => user.role === "teacher");

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role,
          name,
          email,
          password,
          teacherId: role === "student" ? teacherId || undefined : undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not create the account.");
        return;
      }

      setNotice(`${data.user.name} can now sign in with ${data.user.email}.`);
      setName("");
      setEmail("");
      setPassword("");
      await load();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(user: SafeUser) {
    if (
      !confirm(
        `Delete ${user.name}? Their assignments and reading history go too.`,
      )
    ) {
      return;
    }

    const res = await fetch(`/api/users?id=${encodeURIComponent(user.id)}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Could not delete the account.");
      return;
    }

    await load();
  }

  const byRole = (wanted: Role) => list.filter((user) => user.role === wanted);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        title="Teachers & Students"
        subtitle="Accounts you create here can sign in immediately."
      />

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="success">{notice}</Banner>}

      <Card className="mb-6">
        <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
          <Dropdown
            label="Role"
            value={role}
            onChange={(value) => setRole(value as Role)}
            options={[
              { value: "student", label: "Student" },
              { value: "teacher", label: "Teacher" },
              { value: "admin", label: "Administrator" },
            ]}
          />

          {role === "student" && (
            <Dropdown
              label="Teacher"
              value={teacherId}
              onChange={setTeacherId}
              options={[
                { value: "", label: "Unassigned" },
                ...teachers.map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
          )}

          <Input label="Name" value={name} onChange={setName} required />
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            required
          />
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="At least 6 characters"
            required
          />

          <div className="flex items-end sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create account"}
            </Button>
          </div>
        </form>
      </Card>

      {loading ? (
        <Empty>Loading accounts…</Empty>
      ) : (
        (["teacher", "student", "admin"] as Role[]).map((group) => {
          const members = byRole(group);

          if (members.length === 0) return null;

          return (
            <section key={group} className="mb-6">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-subtle)]">
                {group}s
              </h2>

              <Card className="p-0">
                <ul className="divide-y divide-[var(--border)]">
                  {members.map((user) => (
                    <li
                      key={user.id}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{user.name}</p>
                        <p className="truncate text-[11px] text-[var(--text-subtle)]">
                          {user.email}
                          {user.role === "student" && (
                            <>
                              {" · "}
                              {teachers.find((t) => t.id === user.teacherId)?.name ??
                                "No teacher"}
                            </>
                          )}
                        </p>
                      </div>

                      <button
                        onClick={() => remove(user)}
                        aria-label={`Delete ${user.name}`}
                        className="cursor-pointer text-[var(--text-subtle)] transition hover:text-[var(--danger)]"
                      >
                        <TrashIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          );
        })
      )}
    </div>
  );
}
