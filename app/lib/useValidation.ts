"use client";

import { useMemo } from "react";
import type { AgentConfig } from "./types";
import { validateConfig, type Finding } from "./validate";
import { useConnection } from "./ConnectionContext";

/**
 * Validation state for the settings page.
 *
 * Static validation is synchronous and recomputed on every change — it is pure
 * in-memory work over a static catalog, so debouncing would only add lag.
 *
 * Connection-probe results come from ConnectionContext and are folded in when
 * present. They are user-triggered only: never on mount, never on edit, and
 * never required for the page to function.
 */
export function useValidation(cfg: AgentConfig) {
  const { probes, probing, error } = useConnection();

  const findings: Finding[] = useMemo(
    () => validateConfig(cfg, probes),
    [cfg, probes],
  );

  return {
    findings,
    probing,
    probeError: error,
    probeRan: probes !== null,
  };
}
