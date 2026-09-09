/**
 * Sample-rate conversion and WAV container handling for the server.
 *
 * `app/lib/audio.ts` does the equivalent job in the browser, but it leans on
 * AudioContext/OfflineAudioContext, which do not exist in Node. This module is
 * the Node-side counterpart: plain arithmetic over typed arrays, no Web Audio.
 *
 * Two consumers:
 *   - STT, which needs the captured 8 kHz PCM wrapped as a WAV to upload.
 *   - The Sarvam and Gemini TTS paths, which return audio at their own rates
 *     (WAV, and headerless 24 kHz PCM16 respectively) and must be brought down
 *     to 8 kHz. (ElevenLabs and Cartesia emit mu-law directly, so they never
 *     touch this file.)
 */

export type ParsedWav = {
  pcm: Int16Array;
  sampleRate: number;
  channels: number;
};

/**
 * Resample PCM16 by linear interpolation.
 *
 * Note this does not low-pass before downsampling, so it aliases: content
 * above the new Nyquist folds back as distortion. That is acceptable for the
 * paths that use it (TTS output is already band-limited speech), but it is
 * emphatically not acceptable for microphone capture — the browser worklet
 * filters before decimating for exactly this reason.
 */
export function resampleLinear(
  src: Int16Array,
  fromRate: number,
  toRate: number,
): Int16Array {
  if (fromRate === toRate) return src;
  if (src.length === 0) return new Int16Array(0);

  const ratio = fromRate / toRate;
  const outLength = Math.floor(src.length / ratio);
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = src[idx];

    // Hold the last sample rather than reading past the end.
    const b = idx + 1 < src.length ? src[idx + 1] : a;

    out[i] = (a + (b - a) * frac) | 0;
  }

  return out;
}

/** Average interleaved channels down to mono. */
function downmixToMono(pcm: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return pcm;

  const frames = Math.floor(pcm.length / channels);
  const out = new Int16Array(frames);

  for (let i = 0; i < frames; i++) {
    let sum = 0;

    for (let c = 0; c < channels; c++) {
      sum += pcm[i * channels + c];
    }

    out[i] = (sum / channels) | 0;
  }

  return out;
}

/**
 * Parse a RIFF/WAVE buffer into mono PCM16.
 *
 * Walks the chunk list rather than assuming the canonical 44-byte header —
 * encoders are free to insert `LIST`, `fact` or padding chunks before `data`,
 * and a fixed offset silently yields noise when they do.
 */
export function parseWav(buf: Buffer): ParsedWav {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Not a RIFF file.");
  }

  if (buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAVE file.");
  }

  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;
  let format = 1;
  let dataStart = -1;
  let dataLength = 0;

  let offset = 12;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataStart = body;
      // A streamed WAV may declare size 0 or 0xFFFFFFFF; trust the buffer.
      dataLength = size > 0 && body + size <= buf.length ? size : buf.length - body;
    }

    // Chunks are word-aligned: an odd size carries a trailing pad byte.
    offset = body + size + (size % 2);
  }

  if (dataStart < 0) throw new Error("WAV has no data chunk.");

  // 1 = PCM, 0xFFFE = extensible (still PCM for our purposes).
  if (format !== 1 && format !== 0xfffe) {
    throw new Error(`Unsupported WAV format ${format}; expected PCM.`);
  }

  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth ${bitsPerSample}; expected 16.`);
  }

  const sampleCount = Math.floor(dataLength / 2);
  const pcm = new Int16Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = buf.readInt16LE(dataStart + i * 2);
  }

  return { pcm: downmixToMono(pcm, channels), sampleRate, channels: 1 };
}

/**
 * Wrap mono PCM16 in a minimal WAV container.
 *
 * Used to hand a VAD-delimited utterance to the STT providers, which expect a
 * file rather than raw samples.
 */
export function emitWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");

  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample

  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < pcm.length; i++) {
    buf.writeInt16LE(pcm[i], 44 + i * 2);
  }

  return buf;
}

/** Concatenate PCM16 chunks into one buffer. */
export function concatPcm(chunks: Int16Array[]): Int16Array {
  let total = 0;

  for (const c of chunks) total += c.length;

  const out = new Int16Array(total);
  let offset = 0;

  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }

  return out;
}

/** Root-mean-square amplitude of a PCM16 block, normalised to 0..1. */
export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;

  let sum = 0;

  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i];
    sum += s * s;
  }

  return Math.sqrt(sum / pcm.length) / 32768;
}
