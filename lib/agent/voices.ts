/**
 * Provider voice identifiers.
 *
 * Shared by the HTTP TTS route and the call engine. Previously these lived
 * inline in app/api/tts/route.ts; two copies of a hardcoded id map is exactly
 * the kind of thing that drifts silently and then produces the wrong voice on
 * one path only.
 */

/**
 * ElevenLabs addresses voices by opaque id. These are "premade" voices, which
 * free-tier keys may use; library/professional voices need a paid plan.
 */
export const ELEVENLABS_VOICE_IDS: Record<string, string> = {
  Sarah: "EXAVITQu4vr4xnSDxMaL",
  Laura: "FGY2WhTYpPnrIDTdsKH5",
  Roger: "CwhRBWXzGAHq8TQ4Fs17",
  Charlie: "IKne3meq5aSn9XLyUdCD",
  George: "JBFqnCBsd6RMkjVDRZzb",
  Alice: "Xb7hH8MSUJpSbSDYk0k2",
  River: "SAz9YHcvj6GT2YYXdXww",
  Liam: "TX3LPaxmHKxFdv7VOQHJ",
};

export const CARTESIA_VOICE_IDS: Record<string, string> = {
  Sophie: "bf0a246a-8642-498a-9950-80c35e9276b5",
  Marcus: "a0e99841-438c-4a64-b679-ae501e7d6091",
  Nova: "3b554273-4299-48b9-9aaf-eefd438e3941",
};

export function elevenLabsVoiceId(voice: string): string {
  return ELEVENLABS_VOICE_IDS[voice] ?? ELEVENLABS_VOICE_IDS.Sarah;
}

export function cartesiaVoiceId(voice: string): string {
  return CARTESIA_VOICE_IDS[voice] ?? CARTESIA_VOICE_IDS.Sophie;
}
