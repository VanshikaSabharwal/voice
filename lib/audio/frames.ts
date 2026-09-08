/**
 * Framing and playback pacing.
 *
 * Telephony moves audio as a steady drip of equal-sized frames — 20 ms each,
 * 50 a second. TTS providers, by contrast, hand back whatever chunk sizes fall
 * out of their encoder. These two classes bridge that mismatch.
 */

import { FRAME_BYTES, MULAW_SILENCE } from "./mulaw";

/**
 * Re-chops arbitrary byte chunks into exactly-sized frames.
 *
 * A provider may deliver 1147 bytes then 892; the transport needs 160 at a
 * time. Leftovers are retained until the next push completes a frame.
 */
export class FrameSplitter {
  private pending: number[] = [];

  constructor(private readonly frameBytes: number = FRAME_BYTES) {}

  /**
   * Feed bytes in, get whole frames out.
   *
   * Frames are typed as ArrayBuffer-backed because they go straight onto a
   * socket, and `ws.send` will not accept a possibly-shared buffer.
   */
  push(chunk: Uint8Array): Uint8Array<ArrayBuffer>[] {
    const frames: Uint8Array<ArrayBuffer>[] = [];

    for (let i = 0; i < chunk.length; i++) {
      this.pending.push(chunk[i]);

      if (this.pending.length === this.frameBytes) {
        const frame = new Uint8Array(new ArrayBuffer(this.frameBytes));
        frame.set(this.pending);

        frames.push(frame);
        this.pending = [];
      }
    }

    return frames;
  }

  /**
   * Emit whatever is left, padded to a whole frame with silence.
   *
   * Call at end-of-utterance so the tail is not swallowed.
   */
  flush(): Uint8Array<ArrayBuffer> | null {
    if (this.pending.length === 0) return null;

    const frame = new Uint8Array(new ArrayBuffer(this.frameBytes)).fill(
      MULAW_SILENCE,
    );
    frame.set(this.pending);
    this.pending = [];

    return frame;
  }

  /** Drop buffered bytes without emitting them. Used on barge-in. */
  reset(): void {
    this.pending = [];
  }

  get buffered(): number {
    return this.pending.length;
  }
}

type Entry =
  | { kind: "frame"; data: Uint8Array }
  | { kind: "mark"; name: string };

/**
 * Paces frames out at real time, one per 20 ms tick.
 *
 * Pacing is not a nicety — it is what makes interruption meaningful. Handed a
 * ten-second reply, an unpaced queue would push every frame downstream
 * instantly; by the time the caller speaks over it there is nothing left to
 * cancel, because it has all already been sent. Holding the audio here, and
 * releasing it at the rate it is consumed, is what gives `clear()` something
 * to actually throw away.
 *
 * Marks are interleaved as sentinels so the caller learns when a given point
 * in the audio has genuinely played out, rather than merely being queued.
 */
export class PlaybackQueue {
  private queue: Entry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sent = 0;

  constructor(
    private readonly onFrame: (frame: Uint8Array) => void,
    private readonly onMark: (name: string) => void,
    private readonly intervalMs: number = 20,
  ) {}

  enqueue(frames: Uint8Array[]): void {
    for (const data of frames) {
      this.queue.push({ kind: "frame", data });
    }

    this.start();
  }

  /** Queue a named sentinel that fires once the audio ahead of it has played. */
  addMark(name: string): void {
    this.queue.push({ kind: "mark", name });
    this.start();
  }

  /**
   * Discard everything queued. The frames already handed to the transport are
   * gone — cancelling those is the transport's job (`clearBuffer`).
   */
  clear(): void {
    this.queue = [];
  }

  /** Frames actually released downstream, for estimating playback position. */
  get framesSent(): number {
    return this.sent;
  }

  /** Milliseconds of audio released so far. */
  get playedMs(): number {
    return this.sent * this.intervalMs;
  }

  get pending(): number {
    return this.queue.length;
  }

  get idle(): boolean {
    return this.queue.length === 0;
  }

  resetCounter(): void {
    this.sent = 0;
  }

  private start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  private tick(): void {
    // Drain marks eagerly: several may sit between two frames.
    while (this.queue.length > 0 && this.queue[0].kind === "mark") {
      const entry = this.queue.shift() as { kind: "mark"; name: string };
      this.onMark(entry.name);
    }

    const entry = this.queue.shift();

    if (!entry) {
      // Nothing to send. Deliberately emit no audio rather than silence —
      // on a phone call, absence of media *is* silence, and sending filler
      // would only add to the buffer we may need to clear.
      this.stop();
      return;
    }

    if (entry.kind === "frame") {
      this.sent++;
      this.onFrame(entry.data);
    }
  }

  private stop(): void {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.clear();
    this.stop();
  }
}

/**
 * Fixed-size ring of recent frames.
 *
 * Speech onset is only declared after several consecutive loud frames, which
 * means by the time we know the caller started talking, the first syllable is
 * already behind us. Keeping the last few frames lets the utterance buffer be
 * seeded with them so nothing is clipped.
 */
export class FrameRing {
  private buf: Uint8Array[] = [];

  constructor(private readonly capacity: number) {}

  push(frame: Uint8Array): void {
    this.buf.push(frame);

    if (this.buf.length > this.capacity) this.buf.shift();
  }

  drain(): Uint8Array[] {
    const out = this.buf;
    this.buf = [];
    return out;
  }

  clear(): void {
    this.buf = [];
  }
}
