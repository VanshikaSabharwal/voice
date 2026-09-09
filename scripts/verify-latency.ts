/**
 * Per-stage latency, measured against the live providers.
 *
 * Run: npm run verify:latency [n]      (default: 3 runs per stage)
 *
 * Latency is the feature on a phone call, so it deserves a measurement rather
 * than an assumption. This times each stage in isolation and reports the
 * median — a single sample is dominated by whichever request happened to hit a
 * cold path, and the mean is dragged around by one slow outlier.
 *
 * The stages are timed the way a caller experiences them: STT on a real
 * utterance rather than a synthetic tone, LLM with the tool schemas actually
 * attached (they change the number materially), and TTS to *first audio*
 * rather than to completion, because that is when the caller stops waiting.
 */

import { loadEnv } from "../lib/env";

loadEnv();

import { transcribe } from "../lib/agent/stt";
import { runAgent } from "../lib/agent/llm";
import { speak } from "../lib/agent/tts";
import { embed } from "../lib/rag/embed";
import { search, isReady } from "../lib/rag/store";
import { keyFor } from "../app/lib/providers/env";
import { DEFAULT_CONFIG, type AgentConfig } from "../app/lib/types";
import { PRESETS } from "../app/lib/presets";
import { decodeMulaw, SAMPLE_RATE } from "../lib/audio/mulaw";
import { concatPcm, emitWav } from "../lib/audio/resample";

const RUNS = Math.max(1, Number(process.argv[2] ?? 3));

const UTTERANCE = "How long do I have to return something I bought?";

/**
 * Provider combinations worth timing beyond the shipped presets.
 *
 * The point is to isolate one layer at a time: "fastest known" is the target
 * to beat, and each single-provider row shows what that provider costs when
 * everything around it is held constant. A combination whose keys are missing
 * is skipped rather than reported as slow.
 */
const COMBINATIONS: Record<string, Partial<AgentConfig>> = {
  "fastest known": {
    stt: { provider: "sarvam", model: "saaras:v3", language: "en" },
    llm: { ...DEFAULT_CONFIG.llm, provider: "groq", model: "openai/gpt-oss-20b" },
    tts: { ...DEFAULT_CONFIG.tts, provider: "cartesia", model: "sonic-2", voice: "Sophie" },
  },
  "bodhan stt": {
    stt: { provider: "bodhan", model: "indic-transcribe", language: "en" },
    llm: { ...DEFAULT_CONFIG.llm, provider: "groq", model: "openai/gpt-oss-20b" },
    tts: { ...DEFAULT_CONFIG.tts, provider: "cartesia", model: "sonic-2", voice: "Sophie" },
  },
  "bodhan tts": {
    stt: { provider: "sarvam", model: "saaras:v3", language: "en" },
    llm: { ...DEFAULT_CONFIG.llm, provider: "groq", model: "openai/gpt-oss-20b" },
    tts: { ...DEFAULT_CONFIG.tts, provider: "bodhan", model: "indic-speak", voice: "Kavya" },
  },
  "bodhan end to end": {
    stt: { provider: "bodhan", model: "indic-transcribe", language: "en" },
    llm: { ...DEFAULT_CONFIG.llm, provider: "groq", model: "openai/gpt-oss-20b" },
    tts: { ...DEFAULT_CONFIG.tts, provider: "bodhan", model: "indic-speak", voice: "Kavya" },
  },
};

type Sample = { ms: number; note?: string };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function report(label: string, samples: Sample[]): number {
  const ok = samples.filter((s) => !s.note);

  if (ok.length === 0) {
    console.log(`  ${label.padEnd(22)} FAILED — ${samples[0]?.note ?? "no samples"}`);
    return 0;
  }

  const times = ok.map((s) => s.ms);
  const med = median(times);
  const range = `${Math.min(...times)}-${Math.max(...times)}`;

  console.log(
    `  ${label.padEnd(22)} ${String(med).padStart(5)} ms   (n=${ok.length}, range ${range})`,
  );

  return med;
}

/** Run `fn` RUNS times, capturing failures rather than aborting the suite. */
async function time(fn: () => Promise<unknown>): Promise<Sample[]> {
  const out: Sample[] = [];

  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    try {
      await fn();
      out.push({ ms: Date.now() - t0 });
    } catch (err) {
      out.push({ ms: 0, note: err instanceof Error ? err.message.slice(0, 90) : "failed" });
    }
  }

  return out;
}

/**
 * Speak the test utterance once and keep the audio.
 *
 * STT needs realistic input: a synthetic tone measures nothing, since these
 * models short-circuit on audio with no speech in it.
 */
async function makeUtterance(cfg: AgentConfig): Promise<Buffer> {
  const frames: Uint8Array[] = [];

  for await (const f of speak(cfg, UTTERANCE, AbortSignal.timeout(30000))) {
    frames.push(f);
  }

  return emitWav(concatPcm(frames.map(decodeMulaw)), SAMPLE_RATE);
}

async function measure(name: string, cfg: AgentConfig): Promise<void> {
  console.log(`\n${name}`);
  console.log(
    `  stt=${cfg.stt.provider}/${cfg.stt.model}  llm=${cfg.llm.provider}/${cfg.llm.model}  tts=${cfg.tts.provider}/${cfg.tts.model}`,
  );

  // Skip a config whose keys are absent rather than reporting it as slow.
  const missing = (
    [
      [cfg.stt.provider, "stt"],
      [cfg.llm.provider, "llm"],
      [cfg.tts.provider, "tts"],
    ] as const
  )
    .filter(([provider, modality]) => !keyFor(provider, modality))
    .map(([provider]) => provider);

  if (missing.length) {
    console.log(`  SKIPPED — no API key for: ${missing.join(", ")}\n`);
    return;
  }

  let wav: Buffer;

  try {
    wav = await makeUtterance(cfg);
  } catch (err) {
    console.log(`  SKIPPED — could not synthesize test audio: ${(err as Error).message.slice(0, 80)}\n`);
    return;
  }

  const stt = report(
    "STT",
    await time(() =>
      transcribe({
        bytes: wav,
        mimeType: "audio/wav",
        filename: "utterance.wav",
        provider: cfg.stt.provider,
        model: cfg.stt.model,
        language: cfg.stt.language,
      }),
    ),
  );

  // Two LLM numbers, because the difference is the whole cost of RAG.
  const llmPlain = report(
    "LLM (no tool call)",
    await time(() => runAgent(cfg, [{ role: "user", content: "Say hello in one short sentence." }])),
  );

  const llmTool = report(
    "LLM (with tool call)",
    await time(() => runAgent(cfg, [{ role: "user", content: UTTERANCE }])),
  );

  const tts = report(
    "TTS (first audio)",
    await time(async () => {
      for await (const _ of speak(cfg, "Your refund will arrive within five business days.", AbortSignal.timeout(30000))) {
        return; // first frame is what the caller waits for
      }
    }),
  );

  if (stt && llmTool && tts) {
    console.log(
      `  ${"TURN (with tool)".padEnd(22)} ${String(stt + llmTool + tts).padStart(5)} ms   = STT + LLM + TTS`,
    );

    if (llmPlain) {
      console.log(
        `  ${"TURN (no tool)".padEnd(22)} ${String(stt + llmPlain + tts).padStart(5)} ms`,
      );
    }
  }

  console.log("");
}

(async () => {
  console.log(`\nper-stage latency — median of ${RUNS} run(s)`);

  // RAG is config-independent, so it is measured once rather than per preset.
  if (await isReady()) {
    console.log("\nRAG");

    const cold = await time(async () => {
      // A distinct query each time, or the cache makes this meaningless.
      const q = `policy question ${Math.random()}`;
      await search(await embed(q, "RETRIEVAL_QUERY"), 3);
    });

    report("embed + search", cold);

    const warm = await time(() => embed(UTTERANCE, "RETRIEVAL_QUERY"));
    report("embed (cached)", warm);
  } else {
    console.log("\nRAG                      not ingested — run `npm run ingest`");
  }

  for (const preset of PRESETS) {
    await measure(`preset: ${preset.id}`, preset.config);
  }

  // Whatever DEFAULT_CONFIG points at, which is what an unconfigured call gets.
  await measure("DEFAULT_CONFIG", DEFAULT_CONFIG);

  // Ad-hoc combinations worth knowing the cost of. Each is skipped cleanly
  // when its keys are absent, so this stays useful with a partial key set.
  for (const [name, patch] of Object.entries(COMBINATIONS)) {
    await measure(`combo: ${name}`, { ...DEFAULT_CONFIG, ...patch } as AgentConfig);
  }

  console.log("note: TTS is time to FIRST audio frame, not full generation.\n");
})();
