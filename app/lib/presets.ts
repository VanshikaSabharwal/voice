/**
 * Built-in configurations. These ship in code and are read-only.
 *
 * Every preset must validate clean — "Hindi Support" in particular doubles as a
 * fixture proving the Indic path works end to end (Hindi-capable STT model,
 * multilingual TTS model, and a voice that actually speaks Hindi).
 */

import { DEFAULT_CONFIG, type AgentConfig } from "./types";

export type SavedConfig = {
  id: string;
  name: string;
  config: AgentConfig;
  /** Built-ins cannot be edited or deleted. */
  builtin: boolean;
  updatedAt: number;
};

const customerSupport: AgentConfig = {
  ...DEFAULT_CONFIG,
  name: "Customer Support",
};

const hindiSupport: AgentConfig = {
  ...DEFAULT_CONFIG,
  name: "Hindi Support",
  language: "hi",
  systemPrompt:
    "आप हमारी कंपनी के लिए एक सहायक सेवा एजेंट हैं। ग्राहकों की सेवा अनुरोधों में मदद करें, स्थिति बताएं और सवालों के जवाब दें। हमेशा विनम्र और स्पष्ट रहें।",
  // saaras:v3 covers the Indic set; wav is within its accepted formats.
  stt: { provider: "sarvam", model: "saaras:v3", language: "hi" },
  llm: { ...DEFAULT_CONFIG.llm, provider: "gemini", model: "gemini-3.6-flash" },
  // bulbul:v3 speaks Hindi and "priya" is a Hindi-capable speaker.
  tts: {
    provider: "sarvam",
    model: "bulbul:v3",
    voice: "priya",
    stability: 0.5,
    similarityBoost: 0.75,
  },
  general: { ...DEFAULT_CONFIG.general, recordingFormat: "wav" },
};

// const lowLatency: AgentConfig = {
//   ...DEFAULT_CONFIG,
//   name: "Low Latency Test",
//   llm: {
//     ...DEFAULT_CONFIG.llm,
//     model: "gpt-4o-mini",
//     maxTokens: 300,
//     temperature: 0.2,
//   },
//   tts: {
//     ...DEFAULT_CONFIG.tts,
//     model: "eleven_flash_v2_5",
//   },
//   general: { ...DEFAULT_CONFIG.general, silenceTimeout: 1.0 },
//   advanced: { ...DEFAULT_CONFIG.advanced, endpointingMs: 300 },
// };

// const devTest: AgentConfig = {
//   ...DEFAULT_CONFIG,
//   name: "Dev Test Config",
//   llm: { ...DEFAULT_CONFIG.llm, model: "gpt-4o-mini", temperature: 0 },
//   tools: DEFAULT_CONFIG.tools.map((t) => ({ ...t, enabled: false })),
// };

export const PRESETS: SavedConfig[] = [
  {
    id: "customer-support",
    name: "Customer Support",
    config: customerSupport,
    builtin: true,
    updatedAt: 0,
  },
  {
    id: "hindi-support",
    name: "Hindi Support",
    config: hindiSupport,
    builtin: true,
    updatedAt: 0,
  },
  // {
  //   id: "low-latency",
  //   name: "Low Latency Test",
  //   config: lowLatency,
  //   builtin: true,
  //   updatedAt: 0,
  // },
  // {
  //   id: "dev-test",
  //   name: "Dev Test Config",
  //   config: devTest,
  //   builtin: true,
  //   updatedAt: 0,
  // },
];

export function findPreset(id: string): SavedConfig | undefined {
  return PRESETS.find((p) => p.id === id);
}
