/** M6: prove TTS emits correctly-framed 8kHz mu-law from real providers. */
import { writeFileSync } from "node:fs";
import { loadEnv } from "../lib/env";

loadEnv();
import { speak } from "../lib/agent/tts";
import { decodeMulaw, FRAME_BYTES, SAMPLE_RATE } from "../lib/audio/mulaw";
import { emitWav, concatPcm, rms } from "../lib/audio/resample";
import { DEFAULT_CONFIG } from "../app/lib/types";

const TEXT = "Your service request S R one two three four is in progress.";

async function run(provider: string, model: string, voice: string) {
  const cfg = { ...DEFAULT_CONFIG, tts: { ...DEFAULT_CONFIG.tts, provider, model, voice } };
  const t0 = Date.now();
  const frames: Uint8Array[] = [];
  let firstFrameMs = 0;

  try {
    for await (const f of speak(cfg, TEXT, AbortSignal.timeout(30000))) {
      if (frames.length === 0) firstFrameMs = Date.now() - t0;
      frames.push(f);
    }
  } catch (e) {
    console.log(`  ${provider.padEnd(11)} FAILED: ${(e as Error).message.slice(0, 120)}`);
    return;
  }

  const allSized = frames.every((f) => f.length === FRAME_BYTES);
  const pcm = concatPcm(frames.map(decodeMulaw));
  const dur = pcm.length / SAMPLE_RATE;

  writeFileSync(`/tmp/tts-${provider}.wav`, emitWav(pcm, SAMPLE_RATE));

  console.log(
    `  ${provider.padEnd(11)} ${String(frames.length).padStart(4)} frames  ` +
    `${dur.toFixed(2)}s  rms=${rms(pcm).toFixed(3)}  ` +
    `ttfb=${firstFrameMs}ms  ${allSized ? "all 160B ok" : "BAD FRAME SIZE"}`
  );
}

(async () => {
  console.log("\nTTS -> 8kHz mu-law frames\n");
  await run("elevenlabs", "eleven_flash_v2_5", "Sarah");
  await run("cartesia", "sonic-2", "Sophie");
  console.log("\nwrote /tmp/tts-*.wav\n");
})();
