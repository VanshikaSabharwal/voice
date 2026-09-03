"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_CONFIG, type AgentConfig } from "./types";

/**
 * The active agent configuration, shared between the settings page (which edits
 * it), the sidebar (which shows its name and probes its providers) and the
 * voice bot (which runs it). One source of truth: a provider chosen in Settings
 * is the provider the next turn actually calls.
 *
 * The saved config is fetched once on mount, so a page reload keeps whatever
 * was last saved rather than silently reverting to DEFAULT_CONFIG.
 */

const SAVED_CONFIG_ID = "default-agent";

type ConfigState = {
  cfg: AgentConfig;
  setCfg: React.Dispatch<React.SetStateAction<AgentConfig>>;
  /** Id of the saved config currently loaded, if any. */
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  /** False until the stored config has been fetched (or the fetch failed). */
  ready: boolean;
};

const ConfigContext = createContext<ConfigState | null>(null);

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [cfg, setCfg] = useState<AgentConfig>(DEFAULT_CONFIG);
  // Null until something is actually loaded — claiming a preset is active while
  // cfg is still DEFAULT_CONFIG would misreport the running configuration.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/configs")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { configs?: { id: string; config: AgentConfig }[] } | null) => {
        if (cancelled || !data?.configs) return;
        const saved = data.configs.find((c) => c.id === SAVED_CONFIG_ID);
        if (saved?.config) {
          setCfg(saved.config);
          setActiveId(saved.id);
        }
      })
      .catch(() => {
        // No stored config yet: DEFAULT_CONFIG is a valid starting point.
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(
    () => ({ cfg, setCfg, activeId, setActiveId, ready }),
    [cfg, activeId, ready],
  );

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigState {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error("useConfig must be used within ConfigProvider");
  return ctx;
}
