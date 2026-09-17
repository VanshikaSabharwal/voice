/**
 * Whether streaming reading STT is available for this deployment.
 *
 * Live reading feedback streams through Gemini's Live transcription API; the
 * other configured STT providers (Sarvam, Bodhan) have no streaming path and
 * stay on the chunked recorder. The page probes this once so it can skip the
 * streaming socket entirely when it cannot succeed — no pointless connection
 * attempt, no confusing latency while it falls back.
 */

import { guarded, requireRole } from "../../../../lib/auth/guard";
import { readConfig } from "../../../../lib/reading/asr-config";

export const dynamic = "force-dynamic";

export const GET = guarded(async () => {
  await requireRole("student", "admin", "teacher");

  const config = await readConfig();

  const disabled = process.env.READING_STT_LIVE_DISABLED?.trim() === "1";

  const model = !disabled
    ? process.env.READING_STT_LIVE_MODEL?.trim() ||
      (config.model.endsWith("-live") ? config.model : `${config.model}-live`)
    : undefined;

  return Response.json({
    available: !disabled && config.provider === "gemini" && Boolean(model),
    model,
    language: config.language,
  });
});