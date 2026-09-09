/**
 * STATIC provider -> model -> voice catalog. This file is the single source of
 * truth for BOTH the dropdown options in Settings AND the validation rules.
 *
 * Nothing here is ever fetched from a provider API. Live API calls exist only
 * for the optional "Test Connection" credential probe, which never influences
 * what a user can select.
 *
 * `null` on a capability field means UNKNOWN, not "none". No validation rule
 * may ever emit a finding from a null — absence of evidence is not evidence of
 * mismatch. This is what keeps cross-vendor combinations valid by construction.
 *
 * Maintenance note: vendors add and retire models, so this catalog drifts from
 * reality over time and needs periodic manual review.
 */

export type Modality = "stt" | "llm" | "tts";

/** Short language codes, matching LANGUAGES in ./types. */
export type LangCode = string;

export type ModelCapability = {
  id: string;
  label: string;
  /** Languages the model handles. null = unknown. */
  languages: LangCode[] | null;
  /** STT only: audio containers accepted. null = unknown. */
  inputFormats: string[] | null;
  /** LLM only: supports function/tool calling. null = unknown. */
  toolCalling: boolean | null;
  /** LLM only: total context window in tokens. null = unknown. */
  contextWindow: number | null;
  /** LLM only: max tokens the model may emit. null = unknown. */
  maxOutputTokens: number | null;
  /** Supports incremental/streaming output. null = unknown. */
  streaming: boolean | null;
  /**
   * TTS only: wire formats the model can emit directly, e.g. "ulaw_8000".
   *
   * Telephony carries 8 kHz mu-law, so a model that can emit it needs no
   * decoding or resampling at all — which is the difference between a TTS
   * path with no audio dependencies and one that needs ffmpeg. null = unknown,
   * which per this file's convention must never produce a validation finding.
   */
  outputFormats?: string[] | null;
};

/**
 * TTS output formats, by provider.
 *
 * Kept at provider level rather than per model because the encoder is a
 * property of the API, not of the voice model behind it. Values are verified
 * against the live APIs by scripts/verify-tts.ts rather than taken from docs.
 */
export const TTS_OUTPUT_FORMATS: Record<string, string[]> = {
  // Verified: ?output_format=ulaw_8000 returns mu-law bytes directly.
  elevenlabs: ["ulaw_8000", "pcm_16000", "mp3"],
  // Verified: {container:"raw", encoding:"pcm_mulaw", sample_rate:8000}.
  cartesia: ["ulaw_8000", "pcm_16000", "mp3"],
  // WAV only at a fixed rate, so telephony needs a resample on this path.
  sarvam: ["wav"],
  // Verified: returns raw PCM16 at 24 kHz ("audio/l16; rate=24000"), never
  // mu-law, so this path resamples like Sarvam's.
  gemini: ["pcm_24000"],
  // WAV (PCM16 24 kHz mono) per the API reference; no mu-law option, so this
  // path resamples too. Taken from docs, NOT probed — see the catalog entry.
  bodhan: ["wav"],
};

/**
 * Can this provider emit telephony audio without a decode/resample step?
 *
 * Unknown providers return true: per this file's convention, absent capability
 * data means "unknown", which must never be reported as a problem.
 */
export function emitsTelephonyAudio(provider: string): boolean {
  const formats = TTS_OUTPUT_FORMATS[provider];

  if (!formats) return true;

  return formats.includes("ulaw_8000");
}

export type VoiceCapability = {
  id: string;
  label: string;
  /** Languages this specific voice speaks well. null = unknown. */
  languages: LangCode[] | null;
  /** TTS models this voice works with. null = all models of the provider. */
  modelIds: string[] | null;
};

export type ProviderCapability = {
  provider: string;
  label: string;
  modality: Modality;
  models: ModelCapability[];
  /** TTS only; empty for stt/llm. */
  voices: VoiceCapability[];
};

/** Common Indic set used by the India-focused providers. */
const INDIC: LangCode[] = ["hi", "ta", "te", "mr", "bn"];
/** Whisper-family models are broadly multilingual; listing our supported set. */
const WIDE: LangCode[] = ["en", "en-IN", "hi", "ta", "te", "mr", "bn"];
/** Audio containers a browser MediaRecorder realistically produces. */
const COMMON_AUDIO = ["webm", "mp3", "wav"];

// ---------------------------------------------------------------------------
// Speech-to-Text
// ---------------------------------------------------------------------------

export const STT_CATALOG: ProviderCapability[] = [
   {
    provider: "gemini",
    label: "Gemini",
    modality: "stt",
    voices: [],
    // Multimodal models transcribe audio passed as inline data.
    models: [
      {
        id: "gemini-3.6-flash",
        label: "gemini-3.6-flash",
        languages: WIDE,
        inputFormats: COMMON_AUDIO,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: true,
      },
      {
        id: "gemini-3.5-transcribe",
        label: "gemini-3.5-transcribe",
        languages: WIDE,
        inputFormats: COMMON_AUDIO,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: true,
      },
    ],
  },
  {
    provider: "bodhan",
    label: "Bodhan",
    modality: "stt",
    voices: [],
    /*
     * OpenAI-compatible /v1/audio/transcriptions. UNVERIFIED — see the note on
     * the Bodhan entry in TTS_CATALOG; taken from the API reference, not from a
     * live probe.
     */
    models: [
      {
        id: "indic-transcribe",
        label: "indic-transcribe",
        // 25+ Indian languages plus English; narrowed to this app's set.
        languages: ["en", "en-IN", ...INDIC],
        // WAV is the documented format; FLAC/OGG/MP3 also accepted. WebM is
        // not listed, so the browser re-encodes as it does for Sarvam.
        inputFormats: ["wav", "mp3"],
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: false,
      },
    ],
  },
  {
    provider: "sarvam",
    label: "Sarvam",
    modality: "stt",
    voices: [],
    // saarika:v1/v2 are deprecated; saaras:v3 is the current model.
    // Sarvam rejects WebM, so the browser re-encodes to WAV before upload.
    models: [
      {
        id: "saaras:v3",
        label: "saaras:v3",
        // Indic specialist: Indian English plus the Indic set, not generic "en".
        languages: ["en-IN", ...INDIC],
        inputFormats: ["wav", "mp3"],
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: true,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export const LLM_CATALOG: ProviderCapability[] = [
  {
    provider: "gemini",
    label: "Gemini",
    modality: "llm",
    voices: [],
    // Ids and token limits verified against the live ListModels endpoint;
    // tool calling confirmed per model with a live functionDeclarations probe.
    models: [
      {
        id: "gemini-3.8-flash",
        label: "gemini-3.8-flash",
        languages: WIDE,
        inputFormats: null,
        toolCalling: true,
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        streaming: true,
      },
      {
        id: "gemini-3.5-flash-lite",
        label: "gemini-3.5-flash-lite (fastest)",
        languages: WIDE,
        inputFormats: null,
        toolCalling: true,
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        streaming: true,
      },
      {
        id: "gemini-3.6-flash",
        label: "gemini-3.6-flash",
        languages: WIDE,
        inputFormats: null,
        toolCalling: true,
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        streaming: true,
      },
      {
        id: "gemini-3.5-flash",
        label: "gemini-3.5-flash",
        languages: WIDE,
        inputFormats: null,
        toolCalling: true,
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        streaming: true,
      },
      {
        id: "gemini-2.5-pro",
        label: "gemini-2.5-pro",
        languages: WIDE,
        inputFormats: null,
        toolCalling: true,
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        streaming: true,
      },
    ],
  },
  {
    provider: "groq",
    label: "Groq",
    modality: "llm",
    voices: [],
    /*
     * OpenAI-compatible chat completions. Ids below must match Groq's live
     * model list — verify with:
     *   curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
     *
     * Language support is left null (unknown): these are broadly multilingual
     * but Groq publishes no per-language guarantee, and per this file's
     * convention a null must never raise a finding.
     */
    models: [
      {
        id: "openai/gpt-oss-120b",
        label: "gpt-oss-120b",
        languages: null,
        inputFormats: null,
        toolCalling: true,
        contextWindow: 131072,
        maxOutputTokens: 32768,
        streaming: true,
      },
      {
        id: "openai/gpt-oss-20b",
        label: "gpt-oss-20b (faster)",
        languages: null,
        inputFormats: null,
        toolCalling: true,
        contextWindow: 131072,
        maxOutputTokens: 32768,
        streaming: true,
      },
      {
        id: "qwen/qwen3.8-27b",
        label: "qwen3.8-27b",
        languages: null,
        inputFormats: null,
        toolCalling: true,
        contextWindow: 131072,
        maxOutputTokens: 32768,
        streaming: true,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Text-to-Speech
// ---------------------------------------------------------------------------

export const TTS_CATALOG: ProviderCapability[] = [
  {
    provider: "gemini",
    label: "Gemini",
    modality: "tts",
    /*
     * Ids verified against the live ListModels endpoint and each confirmed to
     * return audio from :generateContent with responseModalities:["AUDIO"].
     * The native-audio models are excluded deliberately: they expose only
     * bidiGenerateContent (the Live websocket API), not the request/response
     * call this engine makes.
     *
     * All three emit 24 kHz PCM16 rather than mu-law, so this provider is the
     * second resampling path in lib/agent/tts.ts.
     */
    models: [
      {
        id: "gemini-3.1-flash-tts-preview",
        label: "gemini-3.1-flash-tts-preview",
        languages: WIDE,
        inputFormats: null,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        // One non-streamed audio blob per request; see the module comment.
        streaming: false,
      },
      {
        id: "gemini-2.5-flash-preview-tts",
        label: "gemini-2.5-flash-preview-tts",
        languages: WIDE,
        inputFormats: null,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: false,
      },
      {
        id: "gemini-2.5-pro-preview-tts",
        label: "gemini-2.5-pro-preview-tts",
        languages: WIDE,
        inputFormats: null,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: false,
      },
    ],
    /*
     * Prebuilt voices, each verified to return 200 against the live API (an
     * invented name returns 400, so the probe distinguishes real ids).
     * Every voice works with every TTS model, and the language range is a
     * property of the model here, so both fields stay unrestricted.
     */
    voices: [
      { id: "Kore", label: "Kore", languages: null, modelIds: null },
      { id: "Puck", label: "Puck", languages: null, modelIds: null },
      { id: "Charon", label: "Charon", languages: null, modelIds: null },
      { id: "Aoede", label: "Aoede", languages: null, modelIds: null },
      { id: "Leda", label: "Leda", languages: null, modelIds: null },
      { id: "Zephyr", label: "Zephyr", languages: null, modelIds: null },
      { id: "Orus", label: "Orus", languages: null, modelIds: null },
      { id: "Fenrir", label: "Fenrir", languages: null, modelIds: null },
    ],
  },
  {
    provider: "bodhan",
    label: "Bodhan",
    modality: "tts",
    /*
     * Bodhan (AI4Bharat / IIT Madras): one Indic speech API behind an
     * OpenAI-compatible surface.
     *
     * UNVERIFIED, unlike every other entry in this file: no BODHAN_API_KEY was
     * available when this was written, so the ids, voices and formats below
     * come from the published API reference rather than from a live probe.
     * Confirm with `npm run verify:tts` once a key is configured.
     *
     * Returns WAV (PCM16 24 kHz) with no mu-law option, so it resamples.
     */
    models: [
      {
        id: "indic-speak",
        label: "indic-speak",
        // 22 Indian languages + English; narrowed to this app's language set.
        languages: ["en", "en-IN", ...INDIC],
        inputFormats: null,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: false,
      },
    ],
    /*
     * Each voice was recorded in one language — carried in the label, so the
     * user can match voice to language — but the API reference is explicit
     * that "any voice can read any of the languages". The recording language
     * is therefore a quality hint, not a capability limit, and `languages`
     * stays null per this file's convention: unknown/unrestricted, and never
     * a source of findings.
     *
     * Encoding the recording language here instead would be actively wrong:
     * it would strand English (no voice was recorded in it) and would warn on
     * every Tamil/Telugu/Marathi/Bengali selection that landed on the first
     * voice in the list.
     *
     * This is the subset of the 45 voices covering the languages this app
     * offers; Bodhan's full list spans 22 languages.
     */
    voices: [
      { id: "Kavya", label: "Kavya (Hindi)", languages: null, modelIds: null },
      { id: "Suhani", label: "Suhani (Hindi)", languages: null, modelIds: null },
      { id: "Amit", label: "Amit (Hindi)", languages: null, modelIds: null },
      { id: "Anitha", label: "Anitha (Tamil)", languages: null, modelIds: null },
      { id: "Arun", label: "Arun (Tamil)", languages: null, modelIds: null },
      { id: "Sravani", label: "Sravani (Telugu)", languages: null, modelIds: null },
      { id: "Vamsi", label: "Vamsi (Telugu)", languages: null, modelIds: null },
      { id: "Anagha", label: "Anagha (Marathi)", languages: null, modelIds: null },
      { id: "Chinmay", label: "Chinmay (Marathi)", languages: null, modelIds: null },
      { id: "Ishita", label: "Ishita (Bengali)", languages: null, modelIds: null },
      { id: "Sourav", label: "Sourav (Bengali)", languages: null, modelIds: null },
    ],
  },
  {
    provider: "elevenlabs",
    label: "ElevenLabs",
    modality: "tts",
    models: [
      {
        id: "eleven_multilingual_v2",
        label: "eleven_multilingual_v2",
        languages: WIDE,
        inputFormats: null,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: true,
      },
      {
        id: "eleven_flash_v2_5",
        label: "eleven_flash_v2_5",
        languages: WIDE,
        inputFormats: null,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: true,
      },
      {
        id: "eleven_turbo_v2_5",
        label: "eleven_turbo_v2_5",
        languages: WIDE,
        inputFormats: null,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: true,
      },
    ],
    /*
     * "premade" voices, which free-tier API keys are allowed to use. Library /
     * professional voices return 402 without a paid plan.
     *
     * Language support is a property of the voice, not just the model — a
     * multilingual model cannot make an English-only voice speak good Hindi.
     * The multilingual voices below are usable only with multilingual models.
     */
    voices: [
      { id: "Sarah", label: "Sarah", languages: ["en"], modelIds: null },
      { id: "Laura", label: "Laura", languages: ["en"], modelIds: null },
      { id: "Roger", label: "Roger", languages: ["en"], modelIds: null },
      { id: "Charlie", label: "Charlie", languages: ["en"], modelIds: null },
      { id: "George", label: "George", languages: ["en"], modelIds: null },
      { id: "Alice", label: "Alice", languages: ["en"], modelIds: null },
      {
        id: "River",
        label: "River (multilingual)",
        languages: WIDE,
        modelIds: ["eleven_multilingual_v2", "eleven_flash_v2_5"],
      },
      {
        id: "Liam",
        label: "Liam (multilingual)",
        languages: WIDE,
        modelIds: ["eleven_multilingual_v2", "eleven_flash_v2_5"],
      },
    ],
  },
  {
    provider: "cartesia",
    label: "Cartesia",
    modality: "tts",
    // sonic-english/sonic-multilingual were sunsetted by Cartesia and now 400.
    // Language sets below were probed against the live API per model.
    models: [
      {
        id: "sonic-3",
        label: "sonic-3",
        languages: WIDE,
        inputFormats: null,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: true,
      },
      {
        id: "sonic-turbo",
        label: "sonic-turbo",
        languages: ["en", "en-IN", "hi"],
        inputFormats: null,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: true,
      },
      {
        id: "sonic-2",
        label: "sonic-2",
        languages: ["en", "en-IN"],
        inputFormats: null,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: true,
      },
    ],
    // All three voices accept every current model; language range comes from
    // the model, so these are left unrestricted.
    voices: [
      { id: "Sophie", label: "Sophie", languages: null, modelIds: null },
      { id: "Marcus", label: "Marcus", languages: null, modelIds: null },
      { id: "Nova", label: "Nova", languages: null, modelIds: null },
    ],
  },
  {
    provider: "sarvam",
    label: "Sarvam",
    modality: "tts",
    // bulbul:v1/v2 are deprecated; v3 is current and has its own speaker set.
    models: [
      {
        id: "bulbul:v3",
        label: "bulbul:v3",
        languages: ["en-IN", ...INDIC],
        inputFormats: null,
        toolCalling: null,
        contextWindow: null,
        maxOutputTokens: null,
        streaming: true,
      },
    ],
    // Speaker names are lowercase and verified against bulbul:v3.
    voices: [
      { id: "priya", label: "Priya", languages: ["en-IN", ...INDIC], modelIds: null },
      { id: "kavya", label: "Kavya", languages: ["en-IN", ...INDIC], modelIds: null },
      { id: "neha", label: "Neha", languages: ["en-IN", ...INDIC], modelIds: null },
      { id: "ritu", label: "Ritu", languages: ["en-IN", ...INDIC], modelIds: null },
      { id: "aditya", label: "Aditya", languages: ["en-IN", ...INDIC], modelIds: null },
      { id: "rahul", label: "Rahul", languages: ["en-IN", ...INDIC], modelIds: null },
      { id: "rohan", label: "Rohan", languages: ["en-IN", ...INDIC], modelIds: null },
      { id: "amit", label: "Amit", languages: ["en-IN", ...INDIC], modelIds: null },
    ],
  },
];

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

const CATALOGS: Record<Modality, ProviderCapability[]> = {
  stt: STT_CATALOG,
  llm: LLM_CATALOG,
  tts: TTS_CATALOG,
};

export type Option = { value: string; label: string };

export function catalogFor(modality: Modality): ProviderCapability[] {
  return CATALOGS[modality];
}

export function findProvider(
  modality: Modality,
  provider: string,
): ProviderCapability | undefined {
  return CATALOGS[modality].find((p) => p.provider === provider);
}

export function findModel(
  modality: Modality,
  provider: string,
  modelId: string,
): ModelCapability | undefined {
  return findProvider(modality, provider)?.models.find((m) => m.id === modelId);
}

export function findVoice(
  provider: string,
  voiceId: string,
): VoiceCapability | undefined {
  return findProvider("tts", provider)?.voices.find((v) => v.id === voiceId);
}

export function providersFor(modality: Modality): Option[] {
  return CATALOGS[modality].map((p) => ({ value: p.provider, label: p.label }));
}

export function modelsFor(modality: Modality, provider: string): Option[] {
  return (
    findProvider(modality, provider)?.models.map((m) => ({
      value: m.id,
      label: m.label,
    })) ?? []
  );
}

export function voicesFor(provider: string): Option[] {
  return (
    findProvider("tts", provider)?.voices.map((v) => ({
      value: v.id,
      label: v.label,
    })) ?? []
  );
}

/** First model id for a provider — used when switching provider resets the model. */
export function firstModelId(modality: Modality, provider: string): string {
  return findProvider(modality, provider)?.models[0]?.id ?? "";
}

export function firstVoiceId(provider: string): string {
  return findProvider("tts", provider)?.voices[0]?.id ?? "";
}

/**
 * Whether a capability list covers a language. A null list means unknown, which
 * always answers `true` so callers never raise a finding on missing data.
 */
export function supportsLanguage(
  languages: LangCode[] | null,
  lang: LangCode,
): boolean {
  if (languages === null) return true;
  if (lang === "auto") return true;
  return languages.includes(lang);
}

// ---------------------------------------------------------------------------
// Derived-option selectors
//
// These drive the "impossible options are not selectable" behaviour in
// Settings. They are computed from the catalog alone, so adding a model or
// voice needs no UI change — the dropdowns follow automatically.
//
// Only fields that STRICTLY DERIVE from another field are filtered here:
// recording format follows from the STT model, and voice follows from the TTS
// model. Where two independent choices conflict (agent language vs STT model),
// filtering would hide the user's own earlier choice, so those stay as
// validator errors with a suggested-alternatives list instead.
// ---------------------------------------------------------------------------

/** Recording formats the chosen STT model cannot accept. */
export function unsupportedFormats(
  provider: string,
  modelId: string,
  allFormats: string[],
): Set<string> {
  const model = findModel("stt", provider, modelId);
  // Unknown capability accepts everything, per the null convention.
  if (!model || model.inputFormats === null) return new Set();
  return new Set(allFormats.filter((f) => !model.inputFormats!.includes(f)));
}

/** A format the chosen STT model does accept, for auto-correcting on switch. */
export function firstSupportedFormat(
  provider: string,
  modelId: string,
  allFormats: string[],
  preferred: string,
): string {
  const model = findModel("stt", provider, modelId);
  if (!model || model.inputFormats === null) return preferred;
  if (model.inputFormats.includes(preferred)) return preferred;
  return allFormats.find((f) => model.inputFormats!.includes(f)) ?? preferred;
}

/**
 * The provider's first model that can speak `lang`, falling back to its first
 * model overall.
 *
 * Used when switching provider: landing on a model that cannot handle the
 * language already chosen would raise an error the user did nothing to cause.
 * The fallback keeps a provider with no model for the language selectable —
 * the mark and the validator then explain why.
 */
export function firstModelIdForLanguage(
  modality: Modality,
  provider: string,
  lang: LangCode,
): string {
  const p = findProvider(modality, provider);
  if (!p) return "";
  const match = p.models.find((m) => supportsLanguage(m.languages, lang));
  return (match ?? p.models[0])?.id ?? "";
}

/**
 * A voice valid for the given model, for auto-correcting on model switch.
 *
 * With `lang`, prefers a voice that also speaks it — otherwise switching to
 * ElevenLabs on Hindi lands on Sarah (English-only) and warns immediately.
 * Falls back to model-compatibility alone, then to the first voice, so a
 * provider is never left with an empty selection.
 */
export function firstVoiceForModel(
  provider: string,
  modelId: string,
  lang?: LangCode,
): string {
  const p = findProvider("tts", provider);
  if (!p) return "";
  const fitsModel = (x: VoiceCapability) =>
    x.modelIds === null || x.modelIds.includes(modelId);
  const v =
    (lang !== undefined
      ? p.voices.find((x) => fitsModel(x) && supportsLanguage(x.languages, lang))
      : undefined) ??
    p.voices.find(fitsModel) ??
    p.voices[0];
  return v?.id ?? "";
}

/**
 * Model ids of one modality that cannot handle `lang`, for marking (NOT
 * removing) them in the dropdowns.
 *
 * Language and provider are independent choices, so these are deliberately not
 * filtered out the way model-derived fields are: a model that silently
 * vanished would hide the user's own language choice as the cause. Marking
 * keeps the constraint visible and leaves the validator's one-click fixes as
 * the way out. Per the null convention, unknown language support never marks.
 */
export function modelsNotSupportingLanguage(
  modality: Modality,
  provider: string,
  lang: LangCode,
): Set<string> {
  const p = findProvider(modality, provider);
  if (!p) return new Set();
  return new Set(
    p.models.filter((m) => !supportsLanguage(m.languages, lang)).map((m) => m.id),
  );
}

/** Providers of one modality with no model at all for `lang`. */
export function providersNotSupportingLanguage(
  modality: Modality,
  lang: LangCode,
): Set<string> {
  return new Set(
    CATALOGS[modality]
      .filter((p) => !p.models.some((m) => supportsLanguage(m.languages, lang)))
      .map((p) => p.provider),
  );
}

/**
 * Models of one modality that can handle `lang`, as human-readable labels.
 * Used to answer "so what SHOULD I pick?" in an error message.
 */
export function modelsSupportingLanguage(
  modality: Modality,
  lang: LangCode,
): { provider: string; providerLabel: string; model: string }[] {
  const out: { provider: string; providerLabel: string; model: string }[] = [];
  for (const p of CATALOGS[modality]) {
    for (const m of p.models) {
      if (supportsLanguage(m.languages, lang)) {
        out.push({ provider: p.provider, providerLabel: p.label, model: m.label });
      }
    }
  }
  return out;
}

/** Same, for TTS voices that can speak `lang` on a given model. */
export function voicesSupportingLanguage(
  provider: string,
  modelId: string,
  lang: LangCode,
): string[] {
  const p = findProvider("tts", provider);
  if (!p) return [];
  return p.voices
    .filter(
      (v) =>
        supportsLanguage(v.languages, lang) &&
        (v.modelIds === null || v.modelIds.includes(modelId)),
    )
    .map((v) => v.label);
}
