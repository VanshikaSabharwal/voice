/**
 * Streaming ASR for reading assessment.
 *
 * Browser -> (this socket) -> Gemini Live (BidiGenerateContent websocket).
 *
 * The API key never reaches the browser: the page opens a plain websocket to
 * the voice server, which holds the key and pipes raw 16-bit PCM audio up to
 * Gemini and transcription events back down. Gemini Live's transcription mode
 * emits two event types the aligner maps straight onto:
 *
 *   serverContent.interimInputTranscription   low-latency partial hypothesis
 *   serverContent.inputTranscription          authoritative final segment
 *
 * Binary frames from the browser are audio (Int16 PCM16 at 16 kHz, little
 * endian). Text frames are JSON control messages:
 *   { type: "end" }   flush any pending partial and finish
 */
import WebSocket from "ws";

import { keyFor } from "../app/lib/providers/env";
import { readConfig } from "../lib/reading/asr-config";

const LIVE_HOST =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** BCP-47 the reading path defaults to English (India). */
const DEFAULT_LANGUAGE = "en-IN";

/** How long a forced flush may wait for the last final segment. */
const FLUSH_TIMEOUT_MS = 4000;

/** How long the setup handshake may take before we give up. */
const SETUP_TIMEOUT_MS = 10000;

/**
 * The model the Live API transcribes with. Env override lets a deployment pin
 * a different live model; otherwise the configured one-shot model's "-live"
 * sibling.
 */
function resolveLiveModel(onShotModel: string): string {
  const override = process.env.READING_STT_LIVE_MODEL?.trim();
  if (override) return override;
  return onShotModel.endsWith("-live") ? onShotModel : `${onShotModel}-live`;
}

export async function handleLiveAsr(
  client: WebSocket,
): Promise<void> {
  let gemini: WebSocket | null = null;
  let closed = false;
  let ended = false;
  let setupTimer: NodeJS.Timeout | undefined;

  const fail = (message: string): void => {
    if (closed) return;
    closed = true;
    client.send(JSON.stringify({ type: "error", message }));
    client.close(1011, message);
  };

  const closeEverything = (): void => {
    if (closed) return;
    closed = true;
    if (setupTimer) clearTimeout(setupTimer);
    gemini?.close();
    client.close();
  };

  const config = await readConfig();

  if (config.provider !== "gemini") {
    fail(
      `Live reading feedback needs the Gemini STT provider (currently ${config.provider}).`,
    );
    return;
  }

  const key = keyFor("gemini", "stt");

  if (!key) {
    fail("No Gemini API key is configured (GOOGLE_API_KEY).");
    return;
  }

  const model = resolveLiveModel(config.model);
  const language = process.env.READING_STT_LIVE_LANGUAGE?.trim() || config.language || DEFAULT_LANGUAGE;

  gemini = new WebSocket(`${LIVE_HOST}?key=${encodeURIComponent(key)}`);

  gemini.on("open", () => {
    gemini?.send(
      JSON.stringify({
        setup: {
          model: `models/${model}`,
          generationConfig: { responseModalities: ["TEXT"] },
          inputAudioTranscription: { languageCodes: [language] },
        },
      }),
    );

    /* The handshake should be near-instant; demand that much rather than
       leaving a child's page hanging on a dead upstream socket. */
    setupTimer = setTimeout(() => {
      if (!closed) {
        fail("The transcription service did not acknowledge the session.");
      }
    }, SETUP_TIMEOUT_MS);
  });

  gemini.on("message", (data: WebSocket.RawData) => {
    if (closed) return;

    let message: {
      setupComplete?: unknown;
      serverContent?: {
        interimInputTranscription?: { text?: string };
        inputTranscription?: { text?: string };
      };
      error?: { message?: string; status?: string };
    };

    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    if (message.setupComplete) {
      if (setupTimer) clearTimeout(setupTimer);
      client.send(JSON.stringify({ type: "ready", model, language }));
      return;
    }

    const interim = message.serverContent?.interimInputTranscription?.text;
    const final = message.serverContent?.inputTranscription?.text;

    if (interim) {
      client.send(JSON.stringify({ type: "interim", text: interim }));
    }

    if (final) {
      client.send(JSON.stringify({ type: "final", text: final }));

      /* A forced flush (client sent "end") finishes as soon as the last
         segment's final lands. */
      if (ended) {
        client.send(JSON.stringify({ type: "done" }));
        closeEverything();
      }
    }

    if (message.error) {
      fail(message.error.message ?? "The transcription service errored.");
    }
  });

  gemini.on("error", (err) => {
    if (!closed) {
      fail(`Live transcription unavailable: ${err.message}`);
    }
  });

  gemini.on("close", () => {
    if (!closed) {
      if (ended) {
        // The final we waited for may never arrive; stop blocking the child.
        client.send(JSON.stringify({ type: "done" }));
      }
      closeEverything();
    }
  });

  client.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
    if (closed || !gemini || gemini.readyState !== WebSocket.OPEN) return;

    if (isBinary) {
      // Raw PCM16, 16 kHz, little endian — exactly what our worklet emits.
      const bytes: Buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as unknown as Uint8Array);
      gemini.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: "audio/pcm;rate=16000",
              data: bytes.toString("base64"),
            },
          },
        }),
      );
      return;
    }

    try {
      const control = JSON.parse(data.toString("utf8")) as { type?: string };

      if (control.type === "end" && !ended) {
        ended = true;
        gemini.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));

        setTimeout(() => {
          if (!closed) {
            client.send(JSON.stringify({ type: "done" }));
            closeEverything();
          }
        }, FLUSH_TIMEOUT_MS);
      }
    } catch {
      // Unknown control message; ignore.
    }
  });

  client.on("close", closeEverything);
  client.on("error", closeEverything);
}