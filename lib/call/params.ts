/**
 * Turns an AgentConfig into the integer frame counts the call loop runs on.
 *
 * `general.vad`, `general.silenceTimeout`, `general.maxDuration`,
 * `advanced.endpointingMs` and `advanced.interruptionEnabled` have existed in
 * the config and the Settings UI since the beginning, but nothing has ever
 * read them — the browser page is push-to-talk, so there was no turn-taking to
 * configure. This is where they finally take effect.
 *
 * Converted once at session start so the per-frame hot path compares integers
 * rather than recomputing milliseconds fifty times a second.
 */

import { FRAME_MS } from "../audio/mulaw";
import type { AgentConfig } from "../../app/lib/types";
import { DEFAULT_VAD_PARAMS, type VadParams } from "../audio/vad";

export type CallParams = {
  vadEnabled: boolean;
  vad: VadParams;
  /** Hard cap on one utterance, in frames. Guards against a stuck-open mic. */
  maxUtteranceFrames: number;
  /** Silence after the agent speaks before re-prompting, in frames. */
  idleRepromptFrames: number;
  interruptionEnabled: boolean;
  fallbackMessage: string;
};

function ms(value: number): number {
  return Math.max(1, Math.round(value / FRAME_MS));
}

export function callParamsFrom(cfg: AgentConfig): CallParams {
  const endpointingMs = cfg.advanced?.endpointingMs ?? 500;
  const silenceTimeout = cfg.general?.silenceTimeout ?? 2.0;
  const maxDuration = cfg.general?.maxDuration ?? 15;

  return {
    // Anything other than "enabled" falls back to a fixed window, which is
    // useful when debugging whether a problem is the VAD or everything else.
    vadEnabled: (cfg.general?.vad ?? "enabled") === "enabled",

    vad: {
      ...DEFAULT_VAD_PARAMS,
      // The primary turn-latency knob. 500 ms -> 25 frames.
      endpointFrames: ms(endpointingMs),
    },

    maxUtteranceFrames: ms(maxDuration * 1000),

    // Distinct from endpointing: this is "the caller has said nothing at all
    // since we stopped talking", which prompts a nudge rather than ending a
    // turn. Conflating the two is a classic voice-agent bug.
    idleRepromptFrames: ms(silenceTimeout * 1000),

    interruptionEnabled: cfg.advanced?.interruptionEnabled ?? true,
    fallbackMessage:
      cfg.advanced?.fallbackMessage?.trim() ||
      "Sorry, I did not catch that. Could you repeat?",
  };
}
