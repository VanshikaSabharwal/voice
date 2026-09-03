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
};

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
    // Ids and token limits verified against the live ListModels endpoint.
    models: [
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

/** A voice valid for the given model, for auto-correcting on model switch. */
export function firstVoiceForModel(provider: string, modelId: string): string {
  const p = findProvider("tts", provider);
  if (!p) return "";
  const v =
    p.voices.find((x) => x.modelIds === null || x.modelIds.includes(modelId)) ??
    p.voices[0];
  return v?.id ?? "";
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
