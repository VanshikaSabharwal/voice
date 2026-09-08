/**
 * G.711 mu-law companding — the codec every phone network speaks.
 *
 * Telephony carries 8 kHz mono audio as 8-bit mu-law: a logarithmic encoding
 * that squeezes 14 bits of dynamic range into a byte. Twilio Media Streams,
 * SIP/RTP (payload type 0) and both of our TTS providers all speak it
 * natively, so this module is the boundary between "phone bytes" and the
 * PCM16 the rest of the engine reasons about.
 *
 * Pure and dependency-free: it runs in Node (the voice server) and in the
 * browser (the test harness) from the same source, which is what keeps the
 * two ends of the wire from drifting apart.
 */

/** Samples in one 20 ms frame at 8 kHz. Also the byte length of a mu-law frame. */
export const FRAME_SAMPLES = 160;

/** A 20 ms mu-law frame is one byte per sample. */
export const FRAME_BYTES = FRAME_SAMPLES;

/** PCM16 is two bytes per sample, so a frame is twice as long. */
export const FRAME_PCM_BYTES = FRAME_SAMPLES * 2;

/** Telephony sample rate. Not negotiable — it is what the PSTN carries. */
export const SAMPLE_RATE = 8000;

/** Frame duration in milliseconds. */
export const FRAME_MS = 20;

/**
 * Mu-law silence is 0xFF, NOT 0x00.
 *
 * This trips people up constantly: zero-filling a mu-law buffer produces a
 * loud buzz rather than silence, because 0x00 decodes to roughly -32124. Any
 * padding, any comfort noise, any "flush the queue" path must use this.
 */
export const MULAW_SILENCE = 0xff;

const BIAS = 0x84;
const CLIP = 32635;

/**
 * Decode table, built once at module load.
 *
 * Every inbound frame from the caller passes through this — at 50 frames a
 * second per call it is the hottest path in the engine, so it must be a
 * lookup rather than per-sample arithmetic.
 */
const DECODE_TABLE = new Int16Array(256);

for (let i = 0; i < 256; i++) {
  // The stored byte is the complement of the encoded value.
  const value = ~i & 0xff;

  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;

  // Reconstruct the magnitude, then remove the bias added during encoding.
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;

  DECODE_TABLE[i] = sign ? -sample : sample;
}

/**
 * Segment (exponent) lookup for the encoder.
 *
 * G.711 divides the magnitude range into 8 logarithmic segments. Indexing by
 * the biased magnitude's high byte gives the exponent directly, avoiding a
 * per-sample search over segment boundaries.
 *
 * The exponent is the position of the highest set bit in that index. The
 * mapping is verified against ITU reference vectors in
 * scripts/verify-audio.ts — worth keeping, since an off-by-one here still
 * produces plausible-sounding audio at entirely the wrong amplitude.
 */
const SEGMENT_TABLE = new Uint8Array(256);

for (let i = 0; i < 256; i++) {
  // Position of the highest set bit: 0..1 -> 0, 2..3 -> 1, 4..7 -> 2, ...
  SEGMENT_TABLE[i] = i === 0 ? 0 : 31 - Math.clz32(i);
}

/** Encode one PCM16 sample to a mu-law byte. */
export function encodeSample(pcm: number): number {
  // Clamp first: the bias arithmetic below overflows on full-scale input.
  let sample = pcm;

  if (sample > CLIP) sample = CLIP;
  else if (sample < -CLIP) sample = -CLIP;

  // Split sign from magnitude; mu-law stores them separately.
  let sign = 0;

  if (sample < 0) {
    sample = -sample;
    sign = 0x80;
  }

  sample += BIAS;

  const exponent = SEGMENT_TABLE[(sample >> 7) & 0xff];

  // Shift the mantissa down out of the segment the exponent identified.
  const mantissa = (sample >> (exponent + 3)) & 0x0f;

  // The wire format stores the complement.
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode one mu-law byte to a PCM16 sample. */
export function decodeSample(mu: number): number {
  return DECODE_TABLE[mu & 0xff];
}

/**
 * Encode a block of PCM16 samples to mu-law bytes.
 *
 * ArrayBuffer is named explicitly in the return type: since TypeScript 5.7 the
 * typed arrays are generic over their backing buffer, so a bare `Uint8Array`
 * admits a SharedArrayBuffer — which `ws.send` and structured-clone transfers
 * reject. These frames go straight onto a socket, so the narrower type is the
 * accurate one.
 */
export function encodeMulaw(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(pcm.length));

  for (let i = 0; i < pcm.length; i++) {
    out[i] = encodeSample(pcm[i]);
  }

  return out;
}

/** Decode a block of mu-law bytes to PCM16 samples. */
export function decodeMulaw(mu: Uint8Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(new ArrayBuffer(mu.length * 2));

  for (let i = 0; i < mu.length; i++) {
    out[i] = DECODE_TABLE[mu[i]];
  }

  return out;
}

/** A frame of pure mu-law silence, for padding or comfort noise. */
export function silenceFrame(bytes: number = FRAME_BYTES): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(bytes)).fill(MULAW_SILENCE);
}
