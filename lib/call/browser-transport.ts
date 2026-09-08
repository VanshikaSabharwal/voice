/**
 * Carries a call over a plain WebSocket to the browser test harness.
 *
 * This is the stand-in for Twilio, and it is deliberately faithful rather than
 * convenient: the same 8 kHz mu-law in 20 ms frames, the same mark semantics,
 * the same rule that audio already sent must be explicitly cleared. If the
 * engine works against this, the Twilio implementation is a protocol
 * translation rather than a redesign.
 *
 * The protocol is simply: binary messages are audio, text messages are control.
 */

import type { WebSocket } from "ws";
import type { MediaTransport, TransportKind } from "./transport";
import { FRAME_BYTES } from "../audio/mulaw";

export type NetworkImpairment = {
  /** Added delay in milliseconds, to imitate a real network. */
  jitterMs?: number;
  /** Fraction of frames to drop, 0..1. */
  loss?: number;
};

export class BrowserTransport implements MediaTransport {
  readonly kind: TransportKind = "browser";

  private audioCb: ((frame: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private markCb: ((name: string) => void) | null = null;
  private paramsCb: ((patch: Record<string, unknown>) => void) | null = null;
  private closed = false;

  constructor(
    readonly id: string,
    private readonly ws: WebSocket,
    private readonly impairment: NetworkImpairment = {},
  ) {
    this.ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.receiveAudio(new Uint8Array(data));
      } else {
        this.receiveControl(data.toString());
      }
    });

    this.ws.on("close", () => this.handleClose());
    this.ws.on("error", () => this.handleClose());
  }

  private receiveAudio(bytes: Uint8Array): void {
    // Twilio only ever delivers whole frames, so the harness must too —
    // accepting ragged input here would hide framing bugs until Twilio day.
    for (let i = 0; i + FRAME_BYTES <= bytes.length; i += FRAME_BYTES) {
      this.audioCb?.(bytes.subarray(i, i + FRAME_BYTES));
    }
  }

  private receiveControl(text: string): void {
    let msg: { type?: string; name?: string } & Record<string, unknown>;

    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    // The harness echoes marks back once its own playback reaches them, the
    // same way Twilio does.
    if (msg.type === "mark" && typeof msg.name === "string") {
      this.markCb?.(msg.name);
      return;
    }

    // Live tuning from the harness sliders. A harness-only affordance: a real
    // carrier has no such channel, which is why it lives here rather than on
    // the MediaTransport interface.
    if (msg.type === "params") {
      this.paramsCb?.(msg as Record<string, unknown>);
    }
  }

  onParams(cb: (patch: Record<string, unknown>) => void): void {
    this.paramsCb = cb;
  }

  onAudio(cb: (frame: Uint8Array) => void): void {
    this.audioCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  onMark(cb: (name: string) => void): void {
    this.markCb = cb;
  }

  sendAudio(frame: Uint8Array): void {
    if (this.closed || this.ws.readyState !== 1) return;

    const { loss = 0, jitterMs = 0 } = this.impairment;

    if (loss > 0 && Math.random() < loss) return;

    if (jitterMs > 0) {
      setTimeout(() => {
        if (!this.closed && this.ws.readyState === 1) {
          this.ws.send(frame, { binary: true });
        }
      }, Math.random() * jitterMs);
      return;
    }

    this.ws.send(frame, { binary: true });
  }

  clearBuffer(): void {
    // The harness holds a playback ring buffer; this resets its pointers,
    // which is what makes an interruption sound immediate.
    this.sendControl({ type: "clear" });
  }

  mark(name: string): void {
    this.sendControl({ type: "mark", name });
  }

  sendControl(message: unknown): void {
    if (this.closed || this.ws.readyState !== 1) return;

    this.ws.send(JSON.stringify(message));
  }

  hangup(): void {
    if (this.closed) return;

    this.sendControl({ type: "hangup" });
    this.closed = true;

    try {
      this.ws.close();
    } catch {
      // Already gone; nothing to do.
    }
  }

  private handleClose(): void {
    if (this.closed) return;

    this.closed = true;
    this.closeCb?.();
  }
}
