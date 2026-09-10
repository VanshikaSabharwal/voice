/**
 * Everything that can be evaluated, and whether it is usable right now.
 *
 * Availability is resolved server-side because API keys live only there. The
 * UI uses it to show a provider as unavailable with the reason, rather than
 * offering it and failing after the user has already committed to a run.
 */

import { STT_CATALOG, LLM_CATALOG, TTS_CATALOG } from "../../../lib/capabilities";
import { availability } from "../../../../lib/eval/plan";
import { priceFor } from "../../../../lib/eval/pricing";
import type { Modality } from "../../../lib/capabilities";

export const dynamic = "force-dynamic";

export async function GET() {
  const catalogs: [Modality, typeof STT_CATALOG][] = [
    ["stt", STT_CATALOG],
    ["llm", LLM_CATALOG],
    ["tts", TTS_CATALOG],
  ];

  const modalities = catalogs.map(([modality, catalog]) => ({
    modality,
    providers: catalog.map((provider) => {
      const check = availability({
        modality,
        provider: provider.provider,
        // Availability is per key, not per model, so any model answers it.
        model: provider.models[0]?.id ?? "",
      });

      return {
        provider: provider.provider,
        label: provider.label,
        available: check.ok,
        reason: check.reason,
        models: provider.models.map((model) => ({
          id: model.id,
          label: model.label,
          languages: model.languages,
          // Lets the UI mark which rows can carry a cost figure at all.
          hasPrice: priceFor(modality, provider.provider, model.id)?.usd != null,
        })),
        voices: provider.voices.map((voice) => ({
          id: voice.id,
          label: voice.label,
          modelIds: voice.modelIds,
        })),
      };
    }),
  }));

  return Response.json({ modalities });
}
