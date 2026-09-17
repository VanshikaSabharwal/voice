/**
 * AudioWorklet processor for streaming reading assessment.
 *
 * Gemini Live transcription expects raw 16-bit PCM at 16 kHz. The browser
 * will not hand us a 16 kHz AudioContext reliably, so like the call harness we
 * decimate from whatever rate it provides — and low-pass first, so the >8 kHz
 * energy that naive decimation of speech would fold back doesn't poison the
 * recogniser.
 *
 * Posts Int16Array chunks (~100 ms each) to the main thread, which forwards
 * them to the voice server. Allocation-light, like all worklets.
 */

/** Live API wants 16 kHz. */
const TARGET_RATE = 16000;

/** ~100 ms of audio at 16 kHz. */
const CHUNK_SAMPLES = 1600;

class LiveCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.ratio = sampleRate / TARGET_RATE;

    // 16-tap FIR low-pass; enough to cut above 8 kHz without costing much on
    // the audio thread.
    this.taps = 16;
    this.history = new Float32Array(this.taps);
    this.historyIndex = 0;

    // Fractional position into the input stream, and the output accumulator.
    this.position = 0;
    this.out = new Int16Array(CHUNK_SAMPLES);
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

      if (this.position >= this.ratio) {
        this.position -= this.ratio;

        let s = filtered;
        if (s > 1) s = 1;
        else if (s < -1) s = -1;

        this.out[this.outIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;

        if (this.outIndex === this.out.length) {
          this.port.postMessage(this.out.slice(0), []);
          this.outIndex = 0;
        }
      }
    }

    return true;
  }
}

registerProcessor("live-capture-processor", LiveCaptureProcessor);