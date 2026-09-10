/**
 * Which STT provider grades reading.
 *
 * Rather than a second provider setting, this follows the agent configuration
 * the admin already chose in Settings — one place to change providers, and the
 * Test Connection button in the sidebar keeps meaning what it says.
 *
 * READING_STT_* environment variables override it, for the case where the
 * assessment wants a different (say, more accurate but slower) model than a
 * latency-sensitive phone call does.
 */

import { COLLECTIONS, tryGetDb } from "../db/mongo";
import { PRESETS, type SavedConfig } from "../../app/lib/presets";
import { DEFAULT_CONFIG } from "../../app/lib/types";

export type AsrConfig = { provider: string; model: string; language: string };

/**
 * Language for reading assessment.
 *
 * Defaults to English rather than the agent's "auto": these are known English
 * pages, and letting the recogniser detect a language per chunk invites it to
 * switch mid-page and score a correct reading as gibberish.
 */
const DEFAULT_LANGUAGE = "en-IN";

export async function readConfig(): Promise<AsrConfig> {
  const override = {
    provider: process.env.READING_STT_PROVIDER?.trim(),
    model: process.env.READING_STT_MODEL?.trim(),
    language: process.env.READING_STT_LANGUAGE?.trim(),
  };

  if (override.provider && override.model) {
    return {
      provider: override.provider,
      model: override.model,
      language: override.language || DEFAULT_LANGUAGE,
    };
  }

  const stt = (await activeAgentConfig()).stt;

  return {
    provider: stt.provider,
    model: stt.model,
    language: override.language || DEFAULT_LANGUAGE,
  };
}

/**
 * The most recently saved agent config, or the first preset.
 *
 * Falls back to DEFAULT_CONFIG rather than throwing: a child who cannot read
 * because no config was saved is a worse failure than reading with defaults.
 */
async function activeAgentConfig() {
  const db = await tryGetDb();

  if (db) {
    try {
      const [saved] = await db
        .collection<SavedConfig>(COLLECTIONS.configs)
        .find({}, { projection: { _id: 0 } })
        .sort({ updatedAt: -1 })
        .limit(1)
        .toArray();

      if (saved?.config) return saved.config;
    } catch (err) {
      console.error("[reading] config read failed:", err);
    }
  }

  return PRESETS[0]?.config ?? DEFAULT_CONFIG;
}
