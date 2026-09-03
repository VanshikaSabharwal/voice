/**
 * Configuration validator. Pure and synchronous — no React, no next, no
 * network. Safe to run on every keystroke.
 *
 * Two invariants:
 *  1. A rule may only fire on a KNOWN capability. Every rule guards `!== null`
 *     first, so unknown data is silently accepted.
 *  2. No rule compares one provider to another. Compatibility is judged from
 *     capabilities alone, so mixing vendors (OpenAI STT -> Gemini LLM ->
 *     ElevenLabs TTS) can never produce a finding.
 */

import type { AgentConfig } from "./types";
import { LANGUAGES } from "./types";
import {
  findModel,
  findProvider,
  findVoice,
  supportsLanguage,
  type LangCode,
} from "./capabilities";

export type Severity = "error" | "warning";

export type Section =
  | "general"
  | "agent"
  | "stt"
  | "llm"
  | "tts"
  | "tools"
  | "advanced";

export type SectionStatus = "ok" | "warning" | "error" | "unknown";

/** A suggested repair the UI can apply with one click. */
export type Fix = {
  label: string;
  /** Shallow-per-section patch, applied by the settings page. */
  patch: {
    section: Exclude<Section, "agent"> | "root";
    values: Record<string, unknown>;
  };
};

export type Finding = {
  /** Stable id, e.g. "tts.voice.languageMismatch". */
  id: string;
  severity: Severity;
  section: Section;
  /** Field within the section, for inline placement. */
  field?: string;
  message: string;
  fix?: Fix;
};

/** Result of an optional Test Connection probe. */
export type ProbeStatus =
  | "ok"
  | "invalid"
  | "missing"
  | "rate_limited"
  | "unreachable";

export type ProbeResult = {
  status: ProbeStatus;
  message?: string;
  checkedAt: number;
};

export type ProbeMap = Record<string, ProbeResult>;

function langLabel(code: LangCode): string {
  return LANGUAGES.find((l) => l.value === code)?.label ?? code;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type Rule = (cfg: AgentConfig) => Finding[];

/** STT model must handle the explicitly chosen transcription language. */
const sttLanguageUnsupported: Rule = (cfg) => {
  if (cfg.stt.language === "auto") return [];
  const model = findModel("stt", cfg.stt.provider, cfg.stt.model);
  if (!model || model.languages === null) return [];
  if (supportsLanguage(model.languages, cfg.stt.language)) return [];

  return [
    {
      id: "stt.language.unsupported",
      severity: "error",
      section: "stt",
      field: "language",
      message: `${model.label} does not support ${langLabel(cfg.stt.language)}. Choose another model or set language to Auto Detect.`,
      fix: {
        label: "Set to Auto Detect",
        patch: { section: "stt", values: { language: "auto" } },
      },
    },
  ];
};

/** On auto-detect, the agent's own language should still be transcribable. */
const agentLanguageSttMismatch: Rule = (cfg) => {
  if (cfg.stt.language !== "auto") return [];
  const model = findModel("stt", cfg.stt.provider, cfg.stt.model);
  if (!model || model.languages === null) return [];
  if (supportsLanguage(model.languages, cfg.language)) return [];

  return [
    {
      id: "agent.language.sttMismatch",
      severity: "warning",
      section: "stt",
      field: "model",
      message: `Agent language is ${langLabel(cfg.language)}, but ${model.label} may not transcribe it accurately.`,
    },
  ];
};

/** The TTS model must be able to speak the agent's language. */
const ttsModelLanguageUnsupported: Rule = (cfg) => {
  const model = findModel("tts", cfg.tts.provider, cfg.tts.model);
  if (!model || model.languages === null) return [];
  if (supportsLanguage(model.languages, cfg.language)) return [];

  const provider = findProvider("tts", cfg.tts.provider);
  const alt = provider?.models.find((m) =>
    supportsLanguage(m.languages, cfg.language),
  );

  return [
    {
      id: "tts.model.languageUnsupported",
      severity: "error",
      section: "tts",
      field: "model",
      message: `${model.label} cannot speak ${langLabel(cfg.language)}.`,
      ...(alt
        ? {
            fix: {
              label: `Switch to ${alt.label}`,
              patch: { section: "tts", values: { model: alt.id } },
            },
          }
        : {}),
    },
  ];
};

/** The selected voice must exist for the selected TTS model. */
const ttsVoiceNotForModel: Rule = (cfg) => {
  const voice = findVoice(cfg.tts.provider, cfg.tts.voice);
  if (!voice || voice.modelIds === null) return [];
  if (voice.modelIds.includes(cfg.tts.model)) return [];

  const provider = findProvider("tts", cfg.tts.provider);
  const alt = provider?.voices.find(
    (v) => v.modelIds === null || v.modelIds.includes(cfg.tts.model),
  );

  return [
    {
      id: "tts.voice.notForModel",
      severity: "error",
      section: "tts",
      field: "voice",
      message: `Voice "${voice.label}" is not available for ${cfg.tts.model}.`,
      ...(alt
        ? {
            fix: {
              label: `Use ${alt.label}`,
              patch: { section: "tts", values: { voice: alt.id } },
            },
          }
        : {}),
    },
  ];
};

/**
 * The voice itself must speak the agent's language. Distinct from the model
 * check: a multilingual model cannot make an English-only voice speak Hindi.
 *
 * Emits the more specific "provider supports it but this voice doesn't" variant
 * when a better voice exists on the same provider.
 */
const ttsVoiceLanguageMismatch: Rule = (cfg) => {
  const voice = findVoice(cfg.tts.provider, cfg.tts.voice);
  if (!voice || voice.languages === null) return [];
  if (supportsLanguage(voice.languages, cfg.language)) return [];

  const provider = findProvider("tts", cfg.tts.provider);
  // A voice is a viable alternative only if it also works with the chosen model.
  const alt = provider?.voices.find(
    (v) =>
      supportsLanguage(v.languages, cfg.language) &&
      (v.modelIds === null || v.modelIds.includes(cfg.tts.model)),
  );

  if (alt) {
    return [
      {
        id: "tts.providerSupportsButVoiceDoesnt",
        severity: "warning",
        section: "tts",
        field: "voice",
        message: `${provider?.label} supports ${langLabel(cfg.language)}, but voice "${voice.label}" does not.`,
        fix: {
          label: `Change to ${alt.label}`,
          patch: { section: "tts", values: { voice: alt.id } },
        },
      },
    ];
  }

  return [
    {
      id: "tts.voice.languageMismatch",
      severity: "warning",
      section: "tts",
      field: "voice",
      message: `Voice "${voice.label}" has limited support for ${langLabel(cfg.language)}.`,
    },
  ];
};

/** Tools require an LLM that can call them. */
const llmToolCallingMissing: Rule = (cfg) => {
  const active = cfg.tools.filter((t) => t.enabled);
  if (active.length === 0) return [];

  const model = findModel("llm", cfg.llm.provider, cfg.llm.model);
  if (!model || model.toolCalling === null) return [];
  if (model.toolCalling) return [];

  return [
    {
      id: "llm.toolCalling.missing",
      severity: "error",
      section: "llm",
      field: "model",
      message: `${active.length} tool${active.length > 1 ? "s are" : " is"} enabled, but ${model.label} does not support tool calling.`,
    },
  ];
};

/** Tool parameter schemas must be well-formed JSON objects. */
const toolsSchemaInvalid: Rule = (cfg) => {
  const findings: Finding[] = [];

  for (const tool of cfg.tools) {
    if (!tool.enabled) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(tool.params);
    } catch {
      findings.push({
        id: "tools.schema.invalid",
        severity: "error",
        section: "tools",
        field: `tools.${tool.id}`,
        message: `${tool.name}: parameters are not valid JSON.`,
      });
      continue;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      findings.push({
        id: "tools.schema.invalid",
        severity: "error",
        section: "tools",
        field: `tools.${tool.id}`,
        message: `${tool.name}: parameters must be a JSON object.`,
      });
    }
  }

  return findings;
};

/** Barge-in needs a model that streams. */
const llmStreamingUnsupported: Rule = (cfg) => {
  if (!cfg.advanced.interruptionEnabled) return [];

  const model = findModel("llm", cfg.llm.provider, cfg.llm.model);
  if (!model || model.streaming === null) return [];
  if (model.streaming) return [];

  return [
    {
      id: "llm.streaming.unsupported",
      severity: "warning",
      section: "advanced",
      field: "interruptionEnabled",
      message: `${model.label} does not stream, so interruptions will not work reliably.`,
      fix: {
        label: "Disable interruptions",
        patch: { section: "advanced", values: { interruptionEnabled: false } },
      },
    },
  ];
};

/**
 * Rough token budget check. The estimate is chars/4, which under-counts
 * Devanagari badly — hence warning-only, never a save blocker.
 */
const llmContextExceeded: Rule = (cfg) => {
  const model = findModel("llm", cfg.llm.provider, cfg.llm.model);
  if (!model) return [];

  const findings: Finding[] = [];

  if (
    model.maxOutputTokens !== null &&
    cfg.llm.maxTokens > model.maxOutputTokens
  ) {
    findings.push({
      id: "llm.contextExceeded",
      severity: "warning",
      section: "llm",
      field: "maxTokens",
      message: `Max Tokens (${cfg.llm.maxTokens}) exceeds the ${model.maxOutputTokens} output limit of ${model.label}.`,
      fix: {
        label: `Set to ${model.maxOutputTokens}`,
        patch: { section: "llm", values: { maxTokens: model.maxOutputTokens } },
      },
    });
  }

  if (model.contextWindow !== null) {
    const prompt = cfg.llm.systemPrompt || cfg.systemPrompt;
    const toolChars = cfg.tools
      .filter((t) => t.enabled)
      .reduce((n, t) => n + t.description.length + t.params.length, 0);
    const estimate = Math.ceil((prompt.length + toolChars) / 4);

    if (estimate + cfg.llm.maxTokens > model.contextWindow) {
      findings.push({
        id: "llm.contextExceeded",
        severity: "warning",
        section: "llm",
        field: "maxTokens",
        message: `Prompt (~${estimate} tokens) plus Max Tokens may exceed the ${model.contextWindow} context window of ${model.label}.`,
      });
    }
  }

  return findings;
};

/** The STT model must accept the format the browser records in. */
const sttFormatUnsupported: Rule = (cfg) => {
  const model = findModel("stt", cfg.stt.provider, cfg.stt.model);
  if (!model || model.inputFormats === null) return [];
  if (model.inputFormats.includes(cfg.general.recordingFormat)) return [];

  return [
    {
      id: "stt.format.unsupported",
      severity: "error",
      section: "general",
      field: "recordingFormat",
      message: `${model.label} does not accept ${cfg.general.recordingFormat.toUpperCase()} audio. Supported: ${model.inputFormats.join(", ")}.`,
      fix: {
        label: `Use ${model.inputFormats[0].toUpperCase()}`,
        patch: {
          section: "general",
          values: { recordingFormat: model.inputFormats[0] },
        },
      },
    },
  ];
};

const RULES: Rule[] = [
  sttLanguageUnsupported,
  agentLanguageSttMismatch,
  ttsModelLanguageUnsupported,
  ttsVoiceNotForModel,
  ttsVoiceLanguageMismatch,
  llmToolCallingMissing,
  toolsSchemaInvalid,
  llmStreamingUnsupported,
  llmContextExceeded,
  sttFormatUnsupported,
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Which section a provider's findings belong to, given the config. */
function sectionsUsingProvider(cfg: AgentConfig, provider: string): Section[] {
  const out: Section[] = [];
  if (cfg.stt.provider === provider) out.push("stt");
  if (cfg.llm.provider === provider) out.push("llm");
  if (cfg.tts.provider === provider) out.push("tts");
  return out;
}

/** Findings derived from an optional Test Connection run. */
function probeFindings(cfg: AgentConfig, probes: ProbeMap): Finding[] {
  const findings: Finding[] = [];

  for (const [provider, result] of Object.entries(probes)) {
    // "missing" means no key configured — informational, never an error:
    // connection checks are optional and must not block a valid config.
    if (result.status === "ok" || result.status === "missing") continue;

    for (const section of sectionsUsingProvider(cfg, provider)) {
      if (result.status === "rate_limited") {
        findings.push({
          id: "provider.rateLimited",
          severity: "warning",
          section,
          message: `${provider}: rate limit or quota reached during the last check.`,
        });
      } else if (result.status === "invalid") {
        findings.push({
          id: "provider.credentials",
          severity: "error",
          section,
          message: `${provider}: API credentials were rejected.`,
        });
      } else {
        findings.push({
          id: "provider.unreachable",
          severity: "warning",
          section,
          message: `${provider}: could not be reached during the last check.`,
        });
      }
    }
  }

  return findings;
}

/**
 * Validate a configuration. `probes` is optional; without it the three runtime
 * rules simply do not run and everything else still works offline.
 */
export function validateConfig(
  cfg: AgentConfig,
  probes?: ProbeMap | null,
): Finding[] {
  const findings = RULES.flatMap((rule) => rule(cfg));
  if (probes) findings.push(...probeFindings(cfg, probes));

  // Errors first so the UI surfaces the blocking problems at the top.
  return findings.sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1,
  );
}

export function findingsFor(
  findings: Finding[],
  section: Section,
  field?: string,
): Finding[] {
  return findings.filter(
    (f) => f.section === section && (field === undefined || f.field === field),
  );
}

export function sectionStatus(
  findings: Finding[],
  section: Section,
): SectionStatus {
  const relevant = findings.filter((f) => f.section === section);
  if (relevant.some((f) => f.severity === "error")) return "error";
  if (relevant.length > 0) return "warning";
  return "ok";
}

export function hasBlockingErrors(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

export function firstError(findings: Finding[]): Finding | undefined {
  return findings.find((f) => f.severity === "error");
}

/** Voice ids that are invalid for the current language (marked, still selectable). */
export function invalidVoiceIds(cfg: AgentConfig): Set<string> {
  const provider = findProvider("tts", cfg.tts.provider);
  if (!provider) return new Set();

  return new Set(
    provider.voices
      .filter((v) => !supportsLanguage(v.languages, cfg.language))
      .map((v) => v.id),
  );
}

/** Voice ids unusable with the current TTS model (rendered disabled). */
export function disabledVoiceIds(cfg: AgentConfig): Set<string> {
  const provider = findProvider("tts", cfg.tts.provider);
  if (!provider) return new Set();

  return new Set(
    provider.voices
      .filter((v) => v.modelIds !== null && !v.modelIds.includes(cfg.tts.model))
      .map((v) => v.id),
  );
}
