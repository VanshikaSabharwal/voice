"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ProbeMap } from "./validate";

/**
 * Shares the optional connection-probe result between the sidebar (which owns
 * the Test Connection button) and the settings page (which folds the result
 * into validation).
 *
 * Probing is always user-initiated. Nothing here runs on mount.
 */

type ConnectionState = {
  probes: ProbeMap | null;
  probing: boolean;
  error: string | null;
  check: (providers: string[]) => Promise<void>;
};

const ConnectionContext = createContext<ConnectionState | null>(null);

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [probes, setProbes] = useState<ProbeMap | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async (providers: string[]) => {
    setProbing(true);
    setError(null);
    try {
      const res = await fetch("/api/providers/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers }),
      });
      if (!res.ok) throw new Error(`Check failed (${res.status})`);
      const data: { results: ProbeMap } = await res.json();
      setProbes(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection check failed");
    } finally {
      setProbing(false);
    }
  }, []);

  const value = useMemo(
    () => ({ probes, probing, error, check }),
    [probes, probing, error, check],
  );

  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection(): ConnectionState {
  const ctx = useContext(ConnectionContext);
  if (!ctx) {
    throw new Error("useConnection must be used within ConnectionProvider");
  }
  return ctx;
}
