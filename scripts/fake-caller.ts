/**
 * A headless caller, for testing the engine without a browser.
 *
 * Connects to the voice server exactly as the harness does, speaks by sending
 * TTS-generated mu-law frames, and reports what it hears back. Because it
 * drives the same protocol, a bug found here is an engine bug rather than an
 * AudioWorklet one — which is the whole reason it exists.
 *
 *   npx tsx scripts/fake-caller.ts "what is the status of S R one two three four"
 */

import WebSocket from "ws";
import { loadEnv } from "../lib/env";

loadEnv();

import { speak } from "../lib/agent/tts";
import { FRAME_BYTES, silenceFrame } from "../lib/audio/mulaw";
import { DEFAULT_CONFIG } from "../app/lib/types";

const UTTERANCE = process.argv[2] ?? "What is the status of service request S R one two three four?";
const BARGE_IN = process.argv.includes("--barge-in");
const AGENT = process.env.AGENT_ID ?? "customer-support";
const STT = process.env.STT_PROVIDER ?? "";
const LLM = process.env.LLM_PROVIDER ?? "";
const TTS = process.env.TTS_PROVIDER ?? "";
const URL =
  `${process.env.VOICE_WS ?? "ws://localhost:3001/ws/call"}?agentId=${AGENT}` +
  (STT ? `&stt=${STT}` : "") +
  (LLM ? `&llm=${LLM}` : "") +
  (TTS ? `&tts=${TTS}` : "");

/** Generate mu-law frames for a phrase, using the same TTS the agent uses. */
/**
 * The caller's own voice.
 *
 * Devanagari and other Indic scripts are detected from the text itself and
 * routed to Sarvam, because Cartesia's English models pronounce them as
 * nonsense — which then transcribes as nonsense and makes a perfectly healthy
 * agent look broken. Set CALLER_LANG to override.
 */
function callerLanguage(text: string): string {
  if (process.env.CALLER_LANG) return process.env.CALLER_LANG;

  // Devanagari, Tamil, Telugu, Bengali, Marathi share these blocks.
  return /[ऀ-ॿ஀-௿ఀ-౿ঀ-৿]/.test(text)
    ? "hi"
    : "en";
}

async function synthesize(text: string): Promise<Uint8Array[]> {
  const language = callerLanguage(text);
  const indic = language !== "en";

  const cfg = {
    ...DEFAULT_CONFIG,
    language,
    tts: indic
      ? { ...DEFAULT_CONFIG.tts, provider: "sarvam", model: "bulbul:v3", voice: "aditya" }
      : { ...DEFAULT_CONFIG.tts, provider: "cartesia", model: "sonic-2", voice: "Marcus" },
  };

  const frames: Uint8Array[] = [];

  for await (const f of speak(cfg, text, AbortSignal.timeout(30000))) {
    frames.push(f);
  }

  return frames;
}

async function main(): Promise<void> {
  console.log(`caller: synthesizing "${UTTERANCE}"`);
  const speech = await synthesize(UTTERANCE);
  console.log(`caller: ${speech.length} frames ready (${(speech.length * 0.02).toFixed(1)}s)\n`);

  const ws = new WebSocket(URL);

  let heardFrames = 0;
  let agentState = "";
  let spoke = false;
  let interrupted = false;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let bargeInWhenSpeaking: (() => void) | null = null;

  const finish = (): void => {
    if (ticker) clearInterval(ticker);
    try { ws.close(); } catch { /* already closed */ }
    setTimeout(() => process.exit(0), 300);
  };

  ws.on("open", () => {
    console.log("caller: connected\n");

    // Send a steady stream at real time, exactly as a phone would: silence
    // while listening, speech when it is our turn.
    let queue: Uint8Array[] = [];

    ticker = setInterval(() => {
      const frame = queue.shift() ?? silenceFrame();
      if (ws.readyState === 1) ws.send(frame, { binary: true });
    }, 20);

    const say = (frames: Uint8Array[]): void => {
      queue = [...frames];
    };

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        heardFrames += Math.floor(data.length / FRAME_BYTES);

        // Interrupt once enough of the greeting has genuinely been heard —
        // roughly 20 frames, or 0.4 seconds of speech.
        if (bargeInWhenSpeaking && heardFrames >= 20) {
          const fire = bargeInWhenSpeaking;
          bargeInWhenSpeaking = null;
          fire();
        }

        return;
      }

      const msg = JSON.parse(data.toString());

      if (msg.type === "state") {
        if (msg.value !== agentState) {
          agentState = msg.value;
          console.log(`  [state] ${msg.value}`);
        }

        // Speak once the agent finishes its greeting and starts listening.
        if (msg.value === "listening" && !spoke) {
          spoke = true;
          console.log(`  caller speaks: "${UTTERANCE}"`);
          say(speech);
        }
      }

      if (msg.type === "mark") {
        ws.send(JSON.stringify({ type: "mark", name: msg.name }));
      }

      if (msg.type === "clear") {
        console.log("  [clear] agent audio flushed (barge-in worked)");
      }

      if (msg.type === "transcript") {
        const tag = msg.role === "user" ? "heard from caller" : "agent says";
        const timing = [
          msg.sttMs ? `stt ${msg.sttMs}ms` : "",
          msg.llmMs ? `llm ${msg.llmMs}ms` : "",
          msg.ttsMs ? `tts ${msg.ttsMs}ms` : "",
        ].filter(Boolean).join(" ");

        console.log(
          `  [${tag}] ${JSON.stringify(msg.text)}` +
          (msg.interrupted ? " (INTERRUPTED)" : "") +
          (msg.toolsUsed?.length ? ` tools=${msg.toolsUsed.join(",")}` : "") +
          (timing ? `  ${timing}` : ""),
        );

        if (msg.role === "assistant" && msg.interrupted) {
          interrupted = true;
          return;
        }

        // Done once the agent has answered what the caller actually said. In
        // barge-in mode that means waiting for the reply *after* the
        // interruption, not the truncated greeting.
        const answered = msg.role === "assistant" && spoke;

        if (answered && (!BARGE_IN || interrupted)) {
          console.log(`\ncaller: heard ${heardFrames} frames of agent audio total`);
          if (BARGE_IN) {
            console.log(
              interrupted
                ? "caller: barge-in CONFIRMED — greeting was cut short"
                : "caller: barge-in did NOT fire",
            );
          }
          finish();
        }
      }

      if (msg.type === "connected") {
        console.log(`  [connected] ${msg.direction} call to agent "${msg.agent}"`);
      }

      if (msg.type === "error") {
        console.log(`  [error] ${msg.message}`);
      }
    });

    // Barge-in mode: talk over the greeting rather than waiting it out.
    // Triggered off real received audio, because interrupting before the
    // agent has actually said anything is not barge-in — it is just talking.
    if (BARGE_IN) {
      bargeInWhenSpeaking = () => {
        console.log("  caller INTERRUPTS mid-greeting");
        spoke = true;
        say(speech);
      };
    }
  });

  ws.on("error", (err) => {
    console.error("caller: socket error —", err.message);
    process.exit(1);
  });

  ws.on("close", () => {
    if (ticker) clearInterval(ticker);
  });

  // Do not hang forever if something upstream stalls. Report where it stopped
  // — a bare "timed out" leaves you guessing which leg of the pipeline failed.
  setTimeout(() => {
    console.log(`\ncaller: timed out after 45s while agent was "${agentState}"`);

    if (agentState === "thinking") {
      console.log(
        "  The LLM did not answer in time. Free-tier Gemini is often the cause;\n" +
        "  try:  LLM_PROVIDER=groq npm run call",
      );
    } else if (agentState === "speaking") {
      console.log("  TTS stalled — the reply never finished generating.");
    } else if (agentState === "capturing") {
      console.log("  The turn never ended. Endpointing may be too long.");
    }

    finish();
  }, 45000);
}

void main();
