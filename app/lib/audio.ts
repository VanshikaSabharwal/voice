"use client";

/**
 * Audio format helpers for the record -> STT hand-off.
 *
 * Browsers can only record WebM/Opus (or MP4 on Safari) — never MP3 or WAV.
 * Providers such as Sarvam accept neither, so the recording is decoded and
 * re-encoded to WAV in the browser before upload.
 */

/** Formats each STT provider will accept on upload. */
const PROVIDER_FORMATS: Record<string, string[]> = {
  // Inline audio data; broadly tolerant of container types.
  gemini: ["webm", "mp3", "wav", "mp4", "m4a"],
  sarvam: ["wav", "mp3"],
};

/** True when the recorded blob can be sent to this provider as-is. */
export function providerAcceptsBlob(provider: string, blob: Blob): boolean {
  const accepted = PROVIDER_FORMATS[provider];
  // Unknown provider: assume it copes, rather than transcoding needlessly.
  if (!accepted) return true;

  const type = blob.type.toLowerCase();
  if (type.includes("webm")) return accepted.includes("webm");
  if (type.includes("mp4") || type.includes("m4a")) return accepted.includes("mp4");
  if (type.includes("mpeg") || type.includes("mp3")) return accepted.includes("mp3");
  if (type.includes("wav")) return accepted.includes("wav");
  return false;
}

/** Write a 44-byte RIFF header followed by 16-bit PCM samples. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling so overdriven input does not wrap around.
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Decode a recorded blob and re-encode it as 16 kHz mono WAV — the format
 * speech APIs expect, and a fraction of the size of full-rate stereo.
 */
export async function toWav(blob: Blob, targetRate = 16000): Promise<Blob> {
  const bytes = await blob.arrayBuffer();

  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;

  const decodeCtx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(bytes.slice(0));
  } finally {
    void decodeCtx.close();
  }

  // Resample to the target rate, mixing down to mono.
  const frames = Math.ceil(decoded.duration * targetRate);
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();

  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), targetRate);
}
