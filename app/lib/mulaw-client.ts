/**
 * Browser-side mu-law codec for the call harness.
 *
 * Mirrors lib/audio/mulaw.ts, which the server uses. The two are kept
 * deliberately identical — the harness exists to imitate a phone line, and it
 * can only do that if both ends encode the same way. The server module is not
 * imported directly because it is Node-oriented (Buffer, node: imports) and
 * this must stay clean for the client bundle.
 *
 * Verified against ITU reference vectors in scripts/verify-audio.ts.
 */

const BIAS = 0x84;
const CLIP = 32635;

export const MULAW_SILENCE = 0xff;
export const FRAME_BYTES = 160;

const DECODE_TABLE = new Int16Array(256);

for (let i = 0; i < 256; i++) {
  const value = ~i & 0xff;

  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;

  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;

  DECODE_TABLE[i] = sign ? -sample : sample;
}

const SEGMENT_TABLE = new Uint8Array(256);

for (let i = 0; i < 256; i++) {
  SEGMENT_TABLE[i] = i === 0 ? 0 : 31 - Math.clz32(i);
}

export function encodeSample(pcm: number): number {
  let sample = pcm;

  if (sample > CLIP) sample = CLIP;
  else if (sample < -CLIP) sample = -CLIP;

  let sign = 0;

  if (sample < 0) {
    sample = -sample;
    sign = 0x80;
  }

  sample += BIAS;

  const exponent = SEGMENT_TABLE[(sample >> 7) & 0xff];
  const mantissa = (sample >> (exponent + 3)) & 0x0f;

  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * The return types name ArrayBuffer explicitly.
 *
 * Since TypeScript 5.7 the typed arrays are generic over their backing buffer,
 * so a bare `Uint8Array` means `Uint8Array<ArrayBufferLike>` — possibly backed
 * by a SharedArrayBuffer. WebSocket.send and postMessage transfers accept only
 * ArrayBuffer-backed views, so the wider type fails at the call site. These
 * always allocate a plain ArrayBuffer; saying so keeps callers clean.
 */
export function encodeMulaw(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(pcm.length));

  for (let i = 0; i < pcm.length; i++) out[i] = encodeSample(pcm[i]);

  return out;
}

export function decodeMulaw(mu: Uint8Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(new ArrayBuffer(mu.length * 2));

  for (let i = 0; i < mu.length; i++) out[i] = DECODE_TABLE[mu[i]];

  return out;
}
