/**
 * The interface CallSession transcribes through.
 *
 * Shaped for streaming even though today's implementation is batch: frames are
 * pushed as they arrive and the transcript is awaited at endpoint. The batch
 * version simply accumulates and uploads once the turn ends.
 *
 * The indirection costs a few lines now and buys the ability to move to a
 * streaming STT vendor later by adding one file — CallSession would not change
 * at all, because it is already written against "push frames, await text"
 * rather than "collect a blob, then POST it".
 */

import { decodeMulaw } from "../audio/mulaw";
import { concatPcm, emitWav } from "../audio/resample";
import { SAMPLE_RATE } from "../audio/mulaw";
import { transcribe } from "./stt";
import type { AgentConfig } from "../../app/lib/types";

export interface Transcriber {
  /** Feed one 160-byte mu-law frame. */
  push(frame: Uint8Array): void;
  /** Close the utterance and resolve its transcript. */
  end(): Promise<string>;
  /** Abandon the utterance; nothing will be transcribed. */
  cancel(): void;
  /** Frames accepted so far, for duration accounting. */
  readonly frameCount: number;
}

class BatchTranscriber implements Transcriber {
  private chunks: Int16Array[] = [];
  private frames = 0;
  private cancelled = false;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly signal?: AbortSignal,
  ) {}

  get frameCount(): number {
    return this.frames;
  }

  push(frame: Uint8Array): void {
    if (this.cancelled) return;

    this.chunks.push(decodeMulaw(frame));
    this.frames++;
  }

  async end(): Promise<string> {
    if (this.cancelled || this.chunks.length === 0) return "";

    const pcm = concatPcm(this.chunks);
    this.chunks = [];

    // Both providers take a container rather than raw samples; at 8 kHz a
    // 15-second cap is ~240 KB, comfortably inside every limit.
    const wav = emitWav(pcm, SAMPLE_RATE);

    return transcribe({
      bytes: wav,
      mimeType: "audio/wav",
      filename: "utterance.wav",
      provider: this.cfg.stt.provider,
      model: this.cfg.stt.model,
      language: this.cfg.stt.language,
      signal: this.signal,
    });
  }

  cancel(): void {
    this.cancelled = true;
    this.chunks = [];
  }
}

export function createTranscriber(
  cfg: AgentConfig,
  signal?: AbortSignal,
): Transcriber {
  return new BatchTranscriber(cfg, signal);
}
