"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { DEFAULT_CONFIG, type AgentConfig } from "./types";

/**
 * The active agent configuration, shared between the settings page (which edits
 * it) and the sidebar (which shows its name and probes its providers).
 */

type ConfigState = {
  cfg: AgentConfig;
  setCfg: React.Dispatch<React.SetStateAction<AgentConfig>>;
  /** Id of the saved config currently loaded, if any. */
  activeId: string | null;
  setActiveId: (id: string | null) => void;
};

const ConfigContext = createContext<ConfigState | null>(null);

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [cfg, setCfg] = useState<AgentConfig>(DEFAULT_CONFIG);
  const [activeId, setActiveId] = useState<string | null>("customer-support");

  const value = useMemo(
    () => ({ cfg, setCfg, activeId, setActiveId }),
    [cfg, activeId],
  );

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigState {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error("useConfig must be used within ConfigProvider");
  return ctx;
}
