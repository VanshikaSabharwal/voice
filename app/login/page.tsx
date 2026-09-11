"use client";

/**
 * Sign-in: choose a role, then sign in as that role.
 *
 * The role picker is not decoration — the chosen role is sent to the login
 * route and checked against the account, so signing in from the Teacher screen
 * with an admin's password is refused. Without that check the three doors
 * would all open on the same room, and the picker would be a lie.
 *
 * Only the admin form is prefilled, matching the account seeded in
 * lib/store/reading.ts. Teachers and students use credentials an admin
 * created, so there is nothing honest to prefill for them.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { BookIcon, ClipboardIcon, SettingsIcon } from "../components/Icons";
import type { Role } from "../../lib/reading/types";

const SEEDED_ADMIN = { email: "admin@example.com", password: "password" };

type RoleCard = {
  role: Role;
  label: string;
  blurb: string;
  Icon: (props: { className?: string }) => React.ReactElement;
};

const ROLES: RoleCard[] = [
  {
    role: "student",
    label: "Student",
    blurb: "Read your assigned pages aloud",
    Icon: BookIcon,
  },
  {
    role: "teacher",
    label: "Teacher",
    blurb: "Assign reading and see results",
    Icon: ClipboardIcon,
  },
  {
    role: "admin",
    label: "Administrator",
    blurb: "Manage books, assessments and accounts",
    Icon: SettingsIcon,
  },
];

function RolePicker({ onPick }: { onPick: (role: Role) => void }) {
  return (
    <div className="w-full max-w-md">
      <div className="mb-8 text-center">
        <h1 className="text-xl font-semibold">Reading Assessment</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Who is signing in?
        </p>
      </div>

      <div className="space-y-3">
        {ROLES.map(({ role, label, blurb, Icon }) => (
          <button
            key={role}
            onClick={() => onPick(role)}
            className="flex w-full cursor-pointer items-center gap-4 rounded-xl border border-[var(--border)] bg-white p-4 text-left transition hover:border-[var(--brand)] hover:shadow-sm"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand)]">
              <Icon className="h-5 w-5" />
            </span>

            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-[11px] text-[var(--text-subtle)]">
                {blurb}
              </span>
            </span>

            <span className="shrink-0 text-[var(--text-subtle)]" aria-hidden="true">
              →
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SignInForm({
  card,
  onBack,
  next,
}: {
  card: RoleCard;
  onBack: () => void;
  next: string | null;
}) {
  const router = useRouter();

  const isAdmin = card.role === "admin";

  const [email, setEmail] = useState(isAdmin ? SEEDED_ADMIN.email : "");
  const [password, setPassword] = useState(isAdmin ? SEEDED_ADMIN.password : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The chosen role travels with the credentials and is verified server
        // side; this is not a client-side filter.
        body: JSON.stringify({ email, password, role: card.role }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not sign in.");
        return;
      }

      /* Refresh so server components re-render with the new session rather
         than serving the signed-out render from cache. */
      router.replace(next || data.redirect || "/");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <button
        onClick={onBack}
        className="mb-4 cursor-pointer text-xs text-[var(--text-muted)] transition hover:text-[var(--brand)]"
      >
        ← Choose a different role
      </button>

      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--brand)] text-white">
          <card.Icon className="h-5 w-5" />
        </span>
        <span>
          <span className="block text-lg font-semibold">{card.label}</span>
          <span className="block text-[11px] text-[var(--text-subtle)]">
            {card.blurb}
          </span>
        </span>
      </div>

      <form
        onSubmit={submit}
        className="rounded-xl border border-[var(--border)] bg-white p-6 shadow-sm"
      >
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
            Email
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            autoFocus={!isAdmin}
            className="w-full rounded-lg border border-[var(--border-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--brand)]"
          />
        </label>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
            Password
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="w-full rounded-lg border border-[var(--border-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--brand)]"
          />
        </label>

        {error && (
          <p className="mt-4 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full cursor-pointer rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "Signing in…" : `Sign in as ${card.label.toLowerCase()}`}
        </button>
      </form>

      <p className="mt-4 text-center text-[11px] text-[var(--text-subtle)]">
        {isAdmin
          ? "Prefilled with the default administrator. Change this password before deploying."
          : `${card.label}s sign in with the account an administrator created for them.`}
      </p>
    </div>
  );
}

function Login() {
  const params = useSearchParams();
  const [role, setRole] = useState<Role | null>(null);

  const card = ROLES.find((r) => r.role === role) ?? null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface-muted)] px-4 py-12">
      {card ? (
        <SignInForm
          card={card}
          onBack={() => setRole(null)}
          next={params.get("next")}
        />
      ) : (
        <RolePicker onPick={setRole} />
      )}
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary to avoid opting the whole route
  // into client-side rendering at build time.
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}
