/**
 * Transcribe one chunk of a child reading aloud.
 *
 * Reuses the project's existing provider-agnostic transcribe() rather than
 * introducing a second STT path, so whichever provider is configured for the
 * voice agent is the one grading reading too.
 *
 * The client posts short chunks as the child reads rather than one recording
 * at the end, which is what lets words be marked while the page is still in
 * progress. Scoring is deliberately NOT done here — the client aligns
 * incrementally for live feedback, and the authoritative score is computed
 * server-side on submit.
 */

import { guarded, requireRole } from "../../../../lib/auth/guard";
import { MAX_STT_BYTES, transcribe } from "../../../../lib/agent/stt";
import { readConfig } from "../../../../lib/reading/asr-config";

export const dynamic = "force-dynamic";

export const POST = guarded(async (request: Request) => {
  await requireRole("student", "admin", "teacher");

  let form: FormData;

  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected a multipart form upload." },
      { status: 400 },
    );
  }

  const audio = form.get("audio");

  if (!(audio instanceof File)) {
    return Response.json({ error: "No audio was uploaded." }, { status: 400 });
  }

  if (audio.size > MAX_STT_BYTES) {
    return Response.json(
      { error: "That recording is too long to transcribe in one piece." },
      { status: 413 },
    );
  }

  // An empty or near-empty blob means the child was silent; transcribing it
  // wastes a provider call and returns nothing useful.
  if (audio.size < 1024) return Response.json({ text: "" });

  const config = await readConfig();

  try {
    const text = await transcribe({
      bytes: Buffer.from(await audio.arrayBuffer()),
      mimeType: audio.type || "audio/webm",
      filename: audio.name || "reading.webm",
      provider: config.provider,
      model: config.model,
      language: config.language,
    });

    return Response.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed.";
    console.error("[reading] transcription failed:", message);

    /* 502 rather than 500: the failure is upstream at the STT provider, and
       the client uses the distinction to keep recording instead of ending the
       page on what may be a transient provider hiccup. */
    return Response.json({ error: message }, { status: 502 });
  }
});
