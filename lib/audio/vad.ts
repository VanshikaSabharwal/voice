/**
 * Voice activity detection and endpointing.
 *
 * On a phone call nobody presses a button to say "I've finished speaking" —
 * the engine has to work it out from the audio. This is that decision, and it
 * sets the felt latency of the whole product: end the turn too eagerly and you
 * cut the caller off mid-sentence, too late and the agent feels sluggish.
 *
 * Deliberately energy-based rather than a model. `node-vad` is an unmaintained
 * native addon and Silero drags in ~50 MB of onnxruntime; at 8 kHz with one
 * speaker on a phone line, RMS against an adaptive noise floor performs well
 * enough and stays comprehensible when it misbehaves — which matters, because
 * tuning this is most of the work of getting a voice agent to feel right.
 */

import { rms } from "./resample";

export type VadParams = {
  /** Frames of speech needed to declare onset. Rejects clicks and line pops. */
  onsetFrames: number;
  /** Frames of silence that end a turn. Derived from `advanced.endpointingMs`. */
  endpointFrames: number;
  /** Noise floor multiplier before a frame counts as speech. */
  thresholdRatio: number;
  /** Absolute floor, so a dead-silent line cannot make the VAD hair-trigger. */
  minThreshold: number;
};

export const DEFAULT_VAD_PARAMS: VadParams = {
  onsetFrames: 3,
  endpointFrames: 25,
  thresholdRatio: 3.0,
  minThreshold: 0.012,
};

export type VadEvent =
  | { type: "onset" }
  | { type: "endpoint" }
  | { type: "none" };

export type VadReading = {
  rms: number;
  threshold: number;
  speech: boolean;
  event: VadEvent["type"];
};

export class Vad {
  private noiseFloor = 0.01;
  private speechRun = 0;
  private silenceRun = 0;
  private inSpeech = false;

  constructor(private params: VadParams = DEFAULT_VAD_PARAMS) {}

  /** Retune mid-call — the harness exposes these as live sliders. */
  setParams(params: Partial<VadParams>): void {
    this.params = { ...this.params, ...params };
  }

  get speaking(): boolean {
    return this.inSpeech;
  }

  get threshold(): number {
    return Math.max(
      this.noiseFloor * this.params.thresholdRatio,
      this.params.minThreshold,
    );
  }

  /**
   * Feed one 20 ms frame; learn whether the turn just started or ended.
   */
  push(pcm: Int16Array): VadReading {
    const level = rms(pcm);
    const threshold = this.threshold;
    const loud = level > threshold;

    let event: VadEvent["type"] = "none";

    if (loud) {
      this.speechRun++;
      this.silenceRun = 0;

      // Only declare onset once per utterance.
      if (!this.inSpeech && this.speechRun >= this.params.onsetFrames) {
        this.inSpeech = true;
        event = "onset";
      }
    } else {
      this.silenceRun++;
      this.speechRun = 0;

      // Adapt the floor on quiet frames only. Learning during speech would
      // let a long utterance drag the threshold up above the speaker's own
      // voice, and the turn would never end.
      this.noiseFloor = this.noiseFloor * 0.995 + level * 0.005;

      if (this.noiseFloor < 0.001) this.noiseFloor = 0.001;
      else if (this.noiseFloor > 0.05) this.noiseFloor = 0.05;

      if (this.inSpeech && this.silenceRun >= this.params.endpointFrames) {
        this.inSpeech = false;
        event = "endpoint";
      }
    }

    return { rms: level, threshold, speech: this.inSpeech, event };
  }

  /**
   * Forget the current utterance without touching the learned noise floor.
   *
   * Used when a turn is abandoned (barge-in, hangup): the room has not
   * changed, so the floor is still the best estimate we have.
   */
  reset(): void {
    this.speechRun = 0;
    this.silenceRun = 0;
    this.inSpeech = false;
  }
}

/**
 * A separate, deliberately trigger-happy detector for interrupting the agent.
 *
 * Barge-in asks a different question from turn-taking: not "has the caller
 * finished?" but "has the caller started?", and it must answer fast enough
 * that talking over the agent feels natural rather than like a fight. It runs
 * on its own so tuning interruption sensitivity cannot disturb endpointing.
 */
export class BargeInDetector {
  private run = 0;

  constructor(
    private readonly frames: number = 3,
    private readonly ratio: number = 3.5,
    private readonly minThreshold: number = 0.02,
  ) {}

  /**
   * @param noiseFloor shared with the main VAD, which learns it during silence
   * @returns true when the caller is talking over the agent
   */
  push(pcm: Int16Array, noiseFloor: number): boolean {
    const threshold = Math.max(noiseFloor * this.ratio, this.minThreshold);

    if (rms(pcm) > threshold) {
      this.run++;
      return this.run >= this.frames;
    }

    this.run = 0;
    return false;
  }

  reset(): void {
    this.run = 0;
  }
}
