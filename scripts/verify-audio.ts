/**
 * M1 verification: prove the audio primitives before anything is built on them.
 *
 * Run: npx tsx scripts/verify-audio.ts
 */

import {
  encodeMulaw,
  decodeMulaw,
  encodeSample,
  decodeSample,
  MULAW_SILENCE,
  FRAME_BYTES,
} from "../lib/audio/mulaw";
import {
  emitWav,
  parseWav,
  resampleLinear,
  rms,
} from "../lib/audio/resample";
import { FrameSplitter, PlaybackQueue, FrameRing } from "../lib/audio/frames";

let failures = 0;

function check(name: string, pass: boolean, detail = ""): void {
  if (pass) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nmu-law");

// The single most consequential constant in the whole engine.
check("encode(0) is silence 0xFF", encodeSample(0) === MULAW_SILENCE,
  `got 0x${encodeSample(0).toString(16)}`);

check("decode(0xFF) is near zero", Math.abs(decodeSample(MULAW_SILENCE)) <= 8,
  `got ${decodeSample(MULAW_SILENCE)}`);

// 0x00 must NOT be silence — if this ever passes, something is very wrong.
check("decode(0x00) is loud (not silence)", Math.abs(decodeSample(0)) > 30000,
  `got ${decodeSample(0)}`);

// Round-trip across the full Int16 range. mu-law is lossy by design, so we
// assert relative error within a segment rather than exact equality.
let worstRel = 0;
let worstAbs = 0;

for (let v = -32000; v <= 32000; v += 7) {
  const back = decodeSample(encodeSample(v));
  const abs = Math.abs(back - v);
  const rel = abs / Math.max(Math.abs(v), 1);

  if (abs > worstAbs) worstAbs = abs;
  // Ignore tiny magnitudes where relative error is meaningless.
  if (Math.abs(v) > 100 && rel > worstRel) worstRel = rel;
}

check("round-trip relative error < 8%", worstRel < 0.08,
  `worst ${(worstRel * 100).toFixed(2)}%, abs ${worstAbs}`);

check("sign preserved", decodeSample(encodeSample(-12000)) < 0 &&
  decodeSample(encodeSample(12000)) > 0);

// Clipping must saturate, not wrap around to the opposite sign.
check("clipping saturates", decodeSample(encodeSample(32767)) > 30000 &&
  decodeSample(encodeSample(-32767)) < -30000);

// Ground truth from the ITU G.711 reference (Python audioop.lin2ulaw).
// This is the check that actually proves interoperability with the phone
// network — everything else only proves we are self-consistent.
const ITU: Array<[number, number, number]> = [
  // [pcm in, expected mu-law byte, expected pcm back]
  [0, 0xff, 0],
  [100, 0xf2, 104],
  [1000, 0xce, 988],
  [8000, 0xa0, 7932],
  [12000, 0x98, 11900],
  [-12000, 0x18, -11900],
  [32767, 0x80, 32124],
  [-32767, 0x00, -32124],
];

let ituOk = true;
const ituBad: string[] = [];

for (const [input, expectedByte, expectedBack] of ITU) {
  const got = encodeSample(input);
  const back = decodeSample(got);

  if (got !== expectedByte || back !== expectedBack) {
    ituOk = false;
    ituBad.push(
      `${input}: got 0x${got.toString(16)}/${back}, want 0x${expectedByte.toString(16)}/${expectedBack}`,
    );
  }
}

check("matches ITU G.711 reference vectors", ituOk, ituBad.join("; "));

const block = new Int16Array(160);
for (let i = 0; i < 160; i++) block[i] = Math.round(8000 * Math.sin(i / 4));

const enc = encodeMulaw(block);
check("block encode length", enc.length === 160, `${enc.length} bytes`);
check("block decode length", decodeMulaw(enc).length === 160);

console.log("\nWAV");

const tone = new Int16Array(8000);
for (let i = 0; i < tone.length; i++) {
  tone[i] = Math.round(10000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
}

const wav = emitWav(tone, 8000);
check("header is 44 bytes + data", wav.length === 44 + tone.length * 2);
check("starts with RIFF", wav.toString("ascii", 0, 4) === "RIFF");

const parsed = parseWav(wav);
check("round-trips rate", parsed.sampleRate === 8000);
check("round-trips sample count", parsed.pcm.length === tone.length);

let exact = true;
for (let i = 0; i < tone.length; i += 13) {
  if (parsed.pcm[i] !== tone[i]) { exact = false; break; }
}
check("round-trips samples exactly", exact);

// A WAV with an extra chunk before `data` — the case a fixed 44-byte offset
// gets wrong. Sarvam and other encoders do emit these.
const listChunk = Buffer.concat([
  Buffer.from("LIST", "ascii"),
  (() => { const b = Buffer.alloc(4); b.writeUInt32LE(10); return b; })(),
  Buffer.alloc(10, 0x20),
]);

const withList = Buffer.concat([
  wav.subarray(0, 36),
  listChunk,
  wav.subarray(36),
]);
withList.writeUInt32LE(withList.length - 8, 4);

const parsedList = parseWav(withList);
check("tolerates a LIST chunk before data",
  parsedList.pcm.length === tone.length && parsedList.sampleRate === 8000,
  `${parsedList.pcm.length} samples`);

console.log("\nresampling");

const at24k = new Int16Array(24000);
for (let i = 0; i < at24k.length; i++) {
  at24k[i] = Math.round(10000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
}

const down = resampleLinear(at24k, 24000, 8000);
check("24k -> 8k length", down.length === 8000, `${down.length}`);
check("24k -> 8k preserves amplitude",
  Math.abs(rms(down) - rms(at24k)) < 0.02,
  `rms ${rms(at24k).toFixed(3)} -> ${rms(down).toFixed(3)}`);

check("identity when rates match", resampleLinear(tone, 8000, 8000) === tone);
check("rms of silence is 0", rms(new Int16Array(160)) === 0);

console.log("\nframing");

const splitter = new FrameSplitter();
const odd = splitter.push(new Uint8Array(1147).fill(0x55));

check("1147 bytes yields 7 frames", odd.length === 7, `${odd.length}`);
check("remainder retained", splitter.buffered === 1147 - 7 * 160,
  `${splitter.buffered} bytes`);
check("every frame is 160 bytes", odd.every((f) => f.length === FRAME_BYTES));

// 27 bytes are held; 133 more completes exactly one frame.
const more = splitter.push(new Uint8Array(133).fill(0x55));
check("next push completes a frame", more.length === 1, `${more.length}`);
check("no bytes left over", splitter.buffered === 0, `${splitter.buffered}`);

check("flush with nothing buffered returns null", splitter.flush() === null);

// A partial frame at end-of-utterance must still be emitted, padded.
splitter.push(new Uint8Array(50).fill(0x55));

const tail = splitter.flush();
check("flush emits a full frame",
  tail !== null && tail.length === FRAME_BYTES, `${tail?.length}`);
check("flush preserves real bytes", tail !== null && tail[49] === 0x55);
check("flush pads the rest with silence",
  tail !== null && tail[50] === MULAW_SILENCE &&
  tail[FRAME_BYTES - 1] === MULAW_SILENCE);
check("flush empties the buffer", splitter.buffered === 0);

const ring = new FrameRing(3);
for (let i = 0; i < 10; i++) ring.push(new Uint8Array([i]));

const kept = ring.drain();
check("ring keeps only the last 3", kept.length === 3, `${kept.length}`);
check("ring keeps the most recent",
  kept[0][0] === 7 && kept[2][0] === 9,
  `[${kept.map((f) => f[0]).join(",")}]`);
check("ring empties on drain", ring.drain().length === 0);

console.log("\nplayback pacing");

const sentFrames: Uint8Array[] = [];
const marks: string[] = [];

const queue = new PlaybackQueue(
  (f) => sentFrames.push(f),
  (n) => marks.push(n),
  5, // speed up the tick so the test is quick
);

queue.enqueue(Array.from({ length: 10 }, () => new Uint8Array(160)));
queue.addMark("done");

// Immediately after enqueueing, nothing should have gone out yet — that is
// the whole point of pacing.
check("nothing sent synchronously", sentFrames.length === 0,
  `${sentFrames.length} sent`);

setTimeout(() => {
  const midCount = sentFrames.length;

  check("frames released over time", midCount > 0 && midCount < 10,
    `${midCount} of 10 after 25ms`);

  // Interrupt mid-playback: the rest must never be sent.
  queue.clear();

  setTimeout(() => {
    check("clear() stops further frames", sentFrames.length === midCount,
      `${sentFrames.length} total`);
    check("mark dropped with the queue", marks.length === 0);

    queue.dispose();

    const q2 = new PlaybackQueue(
      () => {},
      (n) => marks.push(n),
      5,
    );

    q2.enqueue([new Uint8Array(160)]);
    q2.addMark("finished");

    setTimeout(() => {
      check("mark fires after its audio", marks.includes("finished"),
        `marks: [${marks.join(",")}]`);
      check("queue idles when drained", q2.idle);
      check("playedMs tracks frames", q2.playedMs === 5, `${q2.playedMs}ms`);

      q2.dispose();

      console.log(
        failures === 0
          ? "\nM1 verified: all audio primitives pass.\n"
          : `\n${failures} check(s) FAILED.\n`,
      );

      process.exit(failures === 0 ? 0 : 1);
    }, 40);
  }, 40);
}, 25);
