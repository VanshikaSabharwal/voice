/**
 * Shape of a voice-agent configuration. Mirrors the agent spec:
 * Agent -> STT -> LLM -> TTS -> Tools, each layer independently swappable.
 *
 * Provider/model/voice options are NOT defined here — they live in
 * ./capabilities, which is the single source of truth for both the dropdown
 * contents and the validation rules. Import the selectors from there.
 */

export const LANGUAGES = [
  { value: "en", label: "English (en)" },
  { value: "en-IN", label: "English - India (en-IN)" },
  { value: "hi", label: "Hindi (hi)" },
  { value: "ta", label: "Tamil (ta)" },
  { value: "te", label: "Telugu (te)" },
  { value: "mr", label: "Marathi (mr)" },
  { value: "bn", label: "Bengali (bn)" },
];

/** One turn of conversation sent to the LLM. */
export type ChatTurn = { role: "user" | "assistant"; content: string };

export type ToolConfig = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  params: string;
};

export type AgentConfig = {
  name: string;
  language: string;
  systemPrompt: string;

  stt: { provider: string; model: string; language: string };

  llm: {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
    topP: number;
    frequencyPenalty: number;
    presencePenalty: number;
    systemPrompt: string;
  };

  tts: {
    provider: string;
    model: string;
    voice: string;
    stability: number;
    similarityBoost: number;
  };

  tools: ToolConfig[];

  general: {
    vad: string;
    silenceTimeout: number;
    maxDuration: number;
    recordingFormat: string;
  };

  advanced: {
    interruptionEnabled: boolean;
    endpointingMs: number;
    webhookUrl: string;
    fallbackMessage: string;
  };
};

export const DEFAULT_CONFIG: AgentConfig = {
  name: "Service Assistant",
  language: "en",
  systemPrompt:
    "You are a helpful service assistant for our company. Your job is to help users with their service requests, check status, provide updates and answer questions. Always be polite, concise and accurate.",

  stt: { provider: "gemini", model: "gemini-3.5-transcribe", language: "auto" },

  llm: {
    provider: "gemini",
    model: "gemini-3.6-flash",
    temperature: 0.3,
    // Reasoning models spend part of this budget thinking, so a low cap can
    // truncate the spoken reply mid-sentence.
    maxTokens: 2048,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    systemPrompt: "",
  },

  tts: {
    provider: "elevenlabs",
    model: "eleven_multilingual_v2",
    voice: "Sarah",
    stability: 0.5,
    similarityBoost: 0.75,
  },

  tools: [
    {
      id: "get_customer",
      name: "get_customer",
      description: "Look up a customer record by phone number or customer ID.",
      enabled: true,
      params: '{ "customer_id": "string", "phone": "string" }',
    },
    {
      id: "get_service_request",
      name: "get_service_request",
      description: "Fetch the status and details of an existing service request.",
      enabled: true,
      params: '{ "request_id": "string" }',
    },
    {
      id: "create_service_request",
      name: "create_service_request",
      description: "Create a new service request on behalf of the customer.",
      enabled: true,
      params: '{ "customer_id": "string", "issue": "string", "priority": "string" }',
    },
  ],

  general: {
    vad: "enabled",
    silenceTimeout: 2.0,
    maxDuration: 15,
    recordingFormat: "webm",
  },

  advanced: {
    interruptionEnabled: true,
    endpointingMs: 500,
    webhookUrl: "",
    fallbackMessage: "Sorry, I did not catch that. Could you repeat?",
  },
};
