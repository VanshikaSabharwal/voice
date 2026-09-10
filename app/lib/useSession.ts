"use client";

import { useEffect, useState } from "react";
import type { Role } from "../../lib/reading/types";

export type ClientSession = {
  userId: string;
  role: Role;
  name: string;
  email: string;
};

/**
 * The signed-in user, for rendering role-appropriate navigation.
 *
 * This is presentation only — proxy.ts and the route guards decide access.
 * Nothing here should ever be the reason a user can or cannot do something.
 */
export function useSession() {
  const [session, setSession] = useState<ClientSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setSession(data.session ?? null);
      })
      .catch(() => {
        // Treated as signed out; the guards will redirect if that is wrong.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { session, loading };
}
