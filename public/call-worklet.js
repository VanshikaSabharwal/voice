/**
 * AudioWorklet processors for the call harness.
 *
 * Plain JavaScript in /public because addModule() fetches this by URL, outside
 * the bundler. It runs on the audio thread, so it must stay allocation-light
 * and never block — glitches here are indistinguishable from network problems,
 * which makes them expensive to misdiagnose.
 *
 * Two processors:
 *   capture-processor  mic at 48kHz -> low-passed, decimated 8kHz Int16
 *   playback-processor 8kHz Int16 ring buffer -> speakers at native rate
 */

/** Telephony rate. Everything on the wire is this. */
const TARGET_RATE = 8000;

/**
 * Captures microphone audio and hands back 8 kHz Int16 blocks.
 *
 * The browser will not give us an 8 kHz AudioContext reliably, so we decimate
 * from whatever it provides. Crucially that requires a low-pass first:
 * anything above 4 kHz would otherwise fold back into the audible band as
 * aliasing, which sounds like a lisp and measurably degrades transcription.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.ratio = sampleRate / TARGET_RATE;

    // Simple FIR low-pass. Long enough to cut usefully above 4 kHz, short
    // enough to stay cheap on the audio thread.
    this.taps = 16;
    this.history = new Float32Array(this.taps);
    this.historyIndex = 0;

    // Fractional read position into the incoming stream.
    this.position = 0;

    this.out = new Int16Array(160);
    this.outIndex = 0;
  }

  /** Running average across the last `taps` samples. */
  filter(sample) {
    this.history[this.historyIndex] = sample;
    this.historyIndex = (this.historyIndex + 1) % this.taps;

    let sum = 0;
    for (let i = 0; i < this.taps; i++) sum += this.history[i];

    return sum / this.taps;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];

    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const filtered = this.filter(channel[i]);

      this.position += 1;

      // Emit one output sample every `ratio` input samples.
      if (this.position >= this.ratio) {
        this.position -= this.ratio;

        let s = filtered;
        if (s > 1) s = 1;
        else if (s < -1) s = -1;

        this.out[this.outIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;

        // Ship a whole 20 ms frame at a time.
        if (this.outIndex === this.out.length) {
          this.port.postMessage(this.out.slice(0), []);
          this.outIndex = 0;
        }
      }
    }

    return true;
  }
}

/**
 * Plays 8 kHz audio pushed from the main thread.
 *
 * Uses a ring buffer rather than a queue of scheduled AudioBufferSourceNodes,
 * specifically so that interruption is instant: clearing playback is a pointer
 * reset here, whereas cancelling scheduled nodes means tracking and stopping
 * each one and still leaving seams. Since barge-in is the whole point of this
 * harness, the buffer has to be the thing that can be dropped on the floor.
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Two seconds at 8 kHz is ample; audio is paced in at real time.
    this.buffer = new Float32Array(TARGET_RATE * 2);
    this.read = 0;
    this.write = 0;
    this.step = TARGET_RATE / sampleRate;
    this.frac = 0;
    this.playing = false;

    this.port.onmessage = (event) => {
      const msg = event.data;

      if (msg.type === "audio") {
        this.enqueue(msg.samples);
        return;
      }

      if (msg.type === "clear") {
        // Barge-in: forget everything not yet played.
        this.read = 0;
        this.write = 0;
        this.frac = 0;
        this.playing = false;
      }
    };
  }

  enqueue(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.write] = samples[i] / 32768;
      this.write = (this.write + 1) % this.buffer.length;

      // Overrun: drop the oldest sample rather than corrupt the stream.
      if (this.write === this.read) {
        this.read = (this.read + 1) % this.buffer.length;
      }
    }

    this.playing = true;
  }

  available() {
    return (this.write - this.read + this.buffer.length) % this.buffer.length;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];

    if (!out) return true;

    if (!this.playing || this.available() < 2) {
      out.fill(0);
      return true;
    }

    // Upsample from 8 kHz to the context rate by linear interpolation.
    for (let i = 0; i < out.length; i++) {
      if (this.available() < 2) {
        out[i] = 0;
        this.playing = false;
        continue;
      }

      const a = this.buffer[this.read];
      const b = this.buffer[(this.read + 1) % this.buffer.length];

      out[i] = a + (b - a) * this.frac;

      this.frac += this.step;

      while (this.frac >= 1) {
        this.frac -= 1;
        this.read = (this.read + 1) % this.buffer.length;
      }
    }

    // Tell the main thread roughly how much is left, so it can report when
    // playback has drained.
    this.port.postMessage({ type: "level", buffered: this.available() });

    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
registerProcessor("playback-processor", PlaybackProcessor);
