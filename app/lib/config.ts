/**
 * Resolve an agent config by id, for the voice server and the Next API.
 *
 * Reads MongoDB when MONGODB_URL is set, else .data/configs.json. Both
 * processes go through here, which is the point: the voice server runs the
 * call, so if it cannot see what Settings saved, the call silently uses
 * DEFAULT_CONFIG and the edit appears to have done nothing.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PRESETS, type SavedConfig } from "./presets";
import type { AgentConfig } from "./types";
import { COLLECTIONS, tryGetDb } from "../../lib/db/mongo";

const DATA_FILE = path.join(process.cwd(), ".data", "configs.json");

async function fromFile(id: string): Promise<AgentConfig | null> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const configs: SavedConfig[] = JSON.parse(raw);

    const saved = configs.find((config) => config.id === id);
    return saved?.config ?? null;
  } catch {
    return null;
  }
}

export async function getAgentConfig(
  id = "default-agent",
): Promise<AgentConfig | null> {
  // First check built-in presets
  const preset = PRESETS.find((p) => p.id === id);
  if (preset) {
    return preset.config;
  }

  // Then saved configs, from the database when one is configured.
  const db = await tryGetDb();

  if (db) {
    try {
      const doc = await db
        .collection<SavedConfig>(COLLECTIONS.configs)
        .findOne({ id }, { projection: { _id: 0 } });

      if (doc?.config) return doc.config;
    } catch (err) {
      // Fall through to the file store rather than failing the call.
      console.error("[config] mongo read failed:", err);
    }
  }

  return fromFile(id);
}
