"use client";

/**
 * Sign-in form.
 *
 * The admin credentials are prefilled so a fresh install can be opened and
 * used without first reading the docs — the seeded account in
 * lib/store/reading.ts is the matching half of this.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { WaveIcon } from "../components/Icons";

const SEEDED_ADMIN = { email: "admin@example.com", password: "password" };

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();

  const [email, setEmail] = useState(SEEDED_ADMIN.email);
  const [password, setPassword] = useState(SEEDED_ADMIN.password);
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
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not sign in.");
        return;
      }

      /* Prefer where they were originally headed, and refresh so server
         components re-render with the new session rather than serving the
         signed-out cache. */
      router.replace(params.get("next") || data.redirect || "/");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface-muted)] px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--brand)] text-white">
            <WaveIcon className="h-6 w-6" />
          </span>
          <h1 className="text-xl font-semibold">Reading Assessment</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Sign in to continue
          </p>
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
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-center text-[11px] text-[var(--text-subtle)]">
          Admin sign-in is prefilled. Teachers and students use the accounts an
          administrator creates for them.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary to avoid opting the whole route
  // into client-side rendering at build time.
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
