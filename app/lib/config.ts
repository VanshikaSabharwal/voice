import { readFile } from "node:fs/promises";
import path from "node:path";
import { PRESETS, type SavedConfig } from "./presets";
import type { AgentConfig } from "./types";

const DATA_FILE = path.join(process.cwd(), ".data", "configs.json");

export async function getAgentConfig(
  id = "default-agent",
): Promise<AgentConfig | null> {
  // First check built-in presets
  const preset = PRESETS.find((p) => p.id === id);
  if (preset) {
    return preset.config;
  }

  // Then check saved configs
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const configs: SavedConfig[] = JSON.parse(raw);

    const saved = configs.find((config) => config.id === id);
    return saved?.config ?? null;
  } catch {
    return null;
  }
}