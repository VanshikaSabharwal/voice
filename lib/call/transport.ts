/**
 * The seam between the conversation engine and whatever is carrying the audio.
 *
 * CallSession never learns whether it is talking to a browser tab, a Twilio
 * Media Stream or a SIP leg. Everything below this line speaks 8 kHz mu-law in
 * 20 ms frames, which is what the phone network carries anyway — so adding
 * Twilio later means writing one more implementation of this interface, not
 * touching the engine.
 *
 * The interface is deliberately shaped around what telephony actually needs:
 * `clearBuffer` exists because interrupting the agent requires discarding
 * audio already handed downstream, and `mark` exists because knowing when
 * audio *finished playing* is different from knowing when it was sent.
 */

/** How the call arrived. Outbound and inbound differ only at the entry point. */
export type CallDirection = "inbound" | "outbound";

export type TransportKind = "browser" | "twilio" | "sip";

export interface MediaTransport {
  readonly id: string;
  readonly kind: TransportKind;

  /** One 160-byte mu-law frame from the caller. */
  onAudio(cb: (frame: Uint8Array) => void): void;

  /** The far end went away. */
  onClose(cb: () => void): void;

  /** Optional keypad input; Twilio delivers these, the harness can fake them. */
  onDtmf?(cb: (digit: string) => void): void;

  /** Send one 160-byte mu-law frame to the caller. */
  sendAudio(frame: Uint8Array): void;

  /**
   * Discard audio already sent but not yet played.
   *
   * This is the barge-in primitive. Without it, interrupting only stops us
   * queueing *more* audio while the caller keeps hearing what is already
   * buffered downstream — which is exactly the behaviour that makes an agent
   * feel like it is ignoring you.
   */
  clearBuffer(): void;

  /**
   * Ask to be told when audio queued up to this point has actually played.
   *
   * Optional because not every carrier reports it. Twilio echoes marks back;
   * the browser transport emulates them; a SIP leg might offer nothing, in
   * which case the session falls back to estimating from frames sent.
   */
  mark?(name: string): void;
  onMark?(cb: (name: string) => void): void;

  /** Control-plane message to the far end (state, transcripts). Best effort. */
  sendControl?(message: unknown): void;

  hangup(): void;
}
