"use client";

import { useMemo, useState } from "react";
import { AgentConfig, LANGUAGES } from "../lib/types";
import { useConfig } from "../lib/ConfigContext";
import {
  providersFor, modelsFor, voicesFor, firstModelId, firstVoiceId,
} from "../lib/capabilities";
import {
  findingsFor, sectionStatus, hasBlockingErrors, firstError,
  invalidVoiceIds, disabledVoiceIds,
  type Finding, type Section,
} from "../lib/validate";
import { useValidation } from "../lib/useValidation";
import { PRESETS } from "../lib/presets";
import { Field, Select, TextInput, Slider, SectionCard, Toggle } from "../components/Fields";
import ValidationStatus from "../components/ValidationStatus";
import { SaveIcon, MicIcon, SparkIcon, WaveIcon, ToolIcon, PlusIcon, TrashIcon } from "../components/Icons";

const TABS = ["General", "Agent", "STT", "LLM", "TTS", "Tools", "Advanced"] as const;
type Tab = (typeof TABS)[number];

/** Which tab a finding's section belongs to, for the "View" jump. */
const SECTION_TAB: Record<Section, Tab> = {
  general: "General",
  agent: "Agent",
  stt: "STT",
  llm: "LLM",
  tts: "TTS",
  tools: "Tools",
  advanced: "Advanced",
};

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("General");
  const { cfg, setCfg, activeId, setActiveId } = useConfig();
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { findings, probeRan } = useValidation(cfg);
  const blocked = hasBlockingErrors(findings);
  const blockingError = firstError(findings);

  // Typed partial updater per config section, so each tab edits only its own slice.
  function patch<K extends keyof AgentConfig>(key: K, value: Partial<AgentConfig[K]>) {
    setCfg((c) => ({ ...c, [key]: { ...(c[key] as object), ...value } }));
  }

  async function save() {
    if (blocked) return;
    setSaveError(null);

    // Built-in presets are read-only; saving one creates a copy.
    const id =
      activeId && !PRESETS.some((p) => p.id === activeId)
        ? activeId
        : `cfg-${Date.now()}`;

    try {
      const res = await fetch("/api/configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: cfg.name, config: cfg }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      setActiveId(id);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    }
  }

  /** Apply a one-click fix from a finding. */
  function applyFix(fix: NonNullable<Finding["fix"]>) {
    const { section, values } = fix.patch;
    if (section === "root") {
      setCfg((c) => ({ ...c, ...values }));
    } else {
      setCfg((c) => ({ ...c, [section]: { ...(c[section] as object), ...values } }));
    }
  }

  const sttModels = useMemo(() => modelsFor("stt", cfg.stt.provider), [cfg.stt.provider]);
  const llmModels = useMemo(() => modelsFor("llm", cfg.llm.provider), [cfg.llm.provider]);
  const ttsModels = useMemo(() => modelsFor("tts", cfg.tts.provider), [cfg.tts.provider]);
  const voices = useMemo(() => voicesFor(cfg.tts.provider), [cfg.tts.provider]);

  // Incompatible voices stay listed but marked; unusable ones are disabled.
  const markedVoices = useMemo(() => invalidVoiceIds(cfg), [cfg]);
  const unusableVoices = useMemo(() => disabledVoiceIds(cfg), [cfg]);

  /* Switching provider invalidates the current model/voice, so reset to that
     provider's first option rather than leaving a stale incompatible value. */
  function setSttProvider(provider: string) {
    patch("stt", { provider, model: firstModelId("stt", provider) });
  }
  function setLlmProvider(provider: string) {
    patch("llm", { provider, model: firstModelId("llm", provider) });
  }
  function setTtsProvider(provider: string) {
    patch("tts", {
      provider,
      model: firstModelId("tts", provider),
      voice: firstVoiceId(provider),
    });
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Configure your voice agent and providers
          </p>
        </div>
        <button
          onClick={save}
          disabled={blocked}
          title={blocked ? blockingError?.message : undefined}
          className={`flex shrink-0 items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition
            ${blocked
              ? "cursor-not-allowed bg-[var(--border-strong)] text-white/80"
              : "bg-[var(--brand)] text-white hover:bg-[var(--brand-hover)]"
            }`}
        >
          <SaveIcon className="h-4 w-4" />
          {saved ? "Saved" : "Validate & Save"}
        </button>
      </header>

      {saveError && (
        <p className="mt-3 text-xs text-[var(--danger)]">{saveError}</p>
      )}

      <div className="mt-5">
        <ValidationStatus
          findings={findings}
          probeRan={probeRan}
          onApplyFix={applyFix}
          onJump={(section) => setTab(SECTION_TAB[section])}
        />
      </div>

      {/* Tab strip scrolls horizontally on narrow screens instead of wrapping.
          w-0/min-w-full keeps the intrinsic width of the tabs from widening the page. */}
      <div className="mt-6 -mx-4 w-[calc(100%+2rem)] overflow-x-auto px-4 sm:mx-0 sm:w-full sm:px-0">
        <nav className="flex w-max min-w-full gap-1 border-b border-[var(--border)]">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition
                ${tab === t
                  ? "border-[var(--brand)] font-medium text-[var(--brand)]"
                  : "border-transparent text-[var(--text-muted)] hover:text-[var(--foreground)]"
                }`}
            >
              {t}
            </button>
          ))}
        </nav>
      </div>

      <div className="mt-5 space-y-4 pb-10">
        {tab === "General" && (
          <>
            <SectionCard title="Agent Info">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Agent Name">
                  <TextInput value={cfg.name} onChange={(v) => setCfg({ ...cfg, name: v })} />
                </Field>
                <Field label="Language">
                  <Select
                    value={cfg.language}
                    onChange={(v) => setCfg({ ...cfg, language: v })}
                    options={LANGUAGES}
                  />
                </Field>
              </div>
              <Field label="System Prompt" className="mt-4">
                <textarea
                  className="field-input min-h-[110px] resize-y"
                  maxLength={1000}
                  value={cfg.systemPrompt}
                  onChange={(e) => setCfg({ ...cfg, systemPrompt: e.target.value })}
                />
              </Field>
              <p className="mt-1 text-right text-[11px] text-[var(--text-subtle)]">
                {cfg.systemPrompt.length} / 1000
              </p>
            </SectionCard>

            <SectionCard
              title="Speech-to-Text (STT)"
              icon={<MicIcon className="h-3.5 w-3.5" />}
              status={sectionStatus(findings, "stt")}
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Provider">
                  <Select value={cfg.stt.provider} onChange={setSttProvider} options={providersFor("stt")} />
                </Field>
                <Field label="Model" findings={findingsFor(findings, "stt", "model")}>
                  <Select value={cfg.stt.model} onChange={(v) => patch("stt", { model: v })} options={sttModels} />
                </Field>
                <Field label="Language" findings={findingsFor(findings, "stt", "language")}>
                  <Select
                    value={cfg.stt.language}
                    onChange={(v) => patch("stt", { language: v })}
                    options={[{ value: "auto", label: "Auto Detect" }, ...LANGUAGES]}
                  />
                </Field>
              </div>
            </SectionCard>

            <SectionCard
              title="LLM (Large Language Model)"
              icon={<SparkIcon className="h-3.5 w-3.5" />}
              status={sectionStatus(findings, "llm")}
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Provider">
                  <Select value={cfg.llm.provider} onChange={setLlmProvider} options={providersFor("llm")} />
                </Field>
                <Field label="Model" findings={findingsFor(findings, "llm", "model")}>
                  <Select value={cfg.llm.model} onChange={(v) => patch("llm", { model: v })} options={llmModels} />
                </Field>
                <div>
                  <Slider
                    label="Temperature"
                    value={cfg.llm.temperature}
                    onChange={(v) => patch("llm", { temperature: v })}
                  />
                </div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Max Tokens" findings={findingsFor(findings, "llm", "maxTokens")}>
                  <TextInput
                    type="number"
                    value={cfg.llm.maxTokens}
                    onChange={(v) => patch("llm", { maxTokens: Number(v) })}
                  />
                </Field>
                <Field label="Top P">
                  <TextInput
                    type="number"
                    value={cfg.llm.topP}
                    onChange={(v) => patch("llm", { topP: Number(v) })}
                  />
                </Field>
                <Field label="Frequency Penalty">
                  <TextInput
                    type="number"
                    value={cfg.llm.frequencyPenalty}
                    onChange={(v) => patch("llm", { frequencyPenalty: Number(v) })}
                  />
                </Field>
                <Field label="Presence Penalty">
                  <TextInput
                    type="number"
                    value={cfg.llm.presencePenalty}
                    onChange={(v) => patch("llm", { presencePenalty: Number(v) })}
                  />
                </Field>
              </div>
            </SectionCard>

            <SectionCard
              title="Text-to-Speech (TTS)"
              icon={<WaveIcon className="h-3.5 w-3.5" />}
              status={sectionStatus(findings, "tts")}
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Provider">
                  <Select value={cfg.tts.provider} onChange={setTtsProvider} options={providersFor("tts")} />
                </Field>
                <Field label="Model" findings={findingsFor(findings, "tts", "model")}>
                  <Select value={cfg.tts.model} onChange={(v) => patch("tts", { model: v })} options={ttsModels} />
                </Field>
                <Field label="Voice" findings={findingsFor(findings, "tts", "voice")}>
                  <Select
                    value={cfg.tts.voice}
                    onChange={(v) => patch("tts", { voice: v })}
                    options={voices}
                    invalidValues={markedVoices}
                    disabledValues={unusableVoices}
                  />
                </Field>
              </div>
              <p className="mb-3 mt-5 text-xs font-medium">Voice Settings</p>
              <div className="grid gap-5 sm:grid-cols-2">
                <Slider
                  label="Stability"
                  value={cfg.tts.stability}
                  onChange={(v) => patch("tts", { stability: v })}
                />
                <Slider
                  label="Similarity Boost"
                  value={cfg.tts.similarityBoost}
                  onChange={(v) => patch("tts", { similarityBoost: v })}
                />
              </div>
            </SectionCard>

            <SectionCard title="General Settings" status={sectionStatus(findings, "general")}>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Voice Activity Detection">
                  <Select
                    value={cfg.general.vad}
                    onChange={(v) => patch("general", { vad: v })}
                    options={[
                      { value: "enabled", label: "Enabled" },
                      { value: "disabled", label: "Disabled" },
                    ]}
                  />
                </Field>
                <Field label="Silence Timeout (sec)">
                  <TextInput
                    type="number"
                    value={cfg.general.silenceTimeout}
                    onChange={(v) => patch("general", { silenceTimeout: Number(v) })}
                  />
                </Field>
                <Field label="Max Conversation Duration (min)">
                  <TextInput
                    type="number"
                    value={cfg.general.maxDuration}
                    onChange={(v) => patch("general", { maxDuration: Number(v) })}
                  />
                </Field>
                <Field
                  label="Recording Format"
                  findings={findingsFor(findings, "general", "recordingFormat")}
                >
                  <Select
                    value={cfg.general.recordingFormat}
                    onChange={(v) => patch("general", { recordingFormat: v })}
                    options={[
                      { value: "webm", label: "WebM (Opus)" },
                      { value: "mp3", label: "MP3" },
                      { value: "wav", label: "WAV (PCM)" },
                    ]}
                  />
                </Field>
              </div>
            </SectionCard>
          </>
        )}

        {tab === "Agent" && (
          <SectionCard title="Agent Configuration">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Agent Name">
                <TextInput value={cfg.name} onChange={(v) => setCfg({ ...cfg, name: v })} />
              </Field>
              <Field label="Language">
                <Select
                  value={cfg.language}
                  onChange={(v) => setCfg({ ...cfg, language: v })}
                  options={LANGUAGES}
                />
              </Field>
            </div>
            <Field label="System Prompt" className="mt-4">
              <textarea
                className="field-input min-h-[200px] resize-y"
                maxLength={1000}
                value={cfg.systemPrompt}
                onChange={(e) => setCfg({ ...cfg, systemPrompt: e.target.value })}
              />
            </Field>
            <p className="mt-1 text-right text-[11px] text-[var(--text-subtle)]">
              {cfg.systemPrompt.length} / 1000
            </p>
          </SectionCard>
        )}

        {tab === "STT" && (
          <SectionCard
            title="Speech-to-Text"
            icon={<MicIcon className="h-3.5 w-3.5" />}
            status={sectionStatus(findings, "stt")}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider">
                <Select value={cfg.stt.provider} onChange={setSttProvider} options={providersFor("stt")} />
              </Field>
              <Field label="Model" findings={findingsFor(findings, "stt", "model")}>
                <Select value={cfg.stt.model} onChange={(v) => patch("stt", { model: v })} options={sttModels} />
              </Field>
              <Field label="Language" findings={findingsFor(findings, "stt", "language")}>
                <Select
                  value={cfg.stt.language}
                  onChange={(v) => patch("stt", { language: v })}
                  options={[{ value: "auto", label: "Auto Detect" }, ...LANGUAGES]}
                />
              </Field>
            </div>
          </SectionCard>
        )}

        {tab === "LLM" && (
          <SectionCard
            title="Large Language Model"
            icon={<SparkIcon className="h-3.5 w-3.5" />}
            status={sectionStatus(findings, "llm")}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider">
                <Select value={cfg.llm.provider} onChange={setLlmProvider} options={providersFor("llm")} />
              </Field>
              <Field label="Model" findings={findingsFor(findings, "llm", "model")}>
                <Select value={cfg.llm.model} onChange={(v) => patch("llm", { model: v })} options={llmModels} />
              </Field>
            </div>
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <Slider
                label="Temperature"
                value={cfg.llm.temperature}
                onChange={(v) => patch("llm", { temperature: v })}
              />
              <Slider label="Top P" value={cfg.llm.topP} onChange={(v) => patch("llm", { topP: v })} />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Max Tokens" findings={findingsFor(findings, "llm", "maxTokens")}>
                <TextInput
                  type="number"
                  value={cfg.llm.maxTokens}
                  onChange={(v) => patch("llm", { maxTokens: Number(v) })}
                />
              </Field>
              <Field label="Frequency Penalty">
                <TextInput
                  type="number"
                  value={cfg.llm.frequencyPenalty}
                  onChange={(v) => patch("llm", { frequencyPenalty: Number(v) })}
                />
              </Field>
              <Field label="Presence Penalty">
                <TextInput
                  type="number"
                  value={cfg.llm.presencePenalty}
                  onChange={(v) => patch("llm", { presencePenalty: Number(v) })}
                />
              </Field>
            </div>
            <Field label="LLM System Prompt (overrides agent prompt)" className="mt-4">
              <textarea
                className="field-input min-h-[120px] resize-y"
                placeholder="Leave empty to use the agent system prompt"
                value={cfg.llm.systemPrompt}
                onChange={(e) => patch("llm", { systemPrompt: e.target.value })}
              />
            </Field>
          </SectionCard>
        )}

        {tab === "TTS" && (
          <SectionCard
            title="Text-to-Speech"
            icon={<WaveIcon className="h-3.5 w-3.5" />}
            status={sectionStatus(findings, "tts")}
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Provider">
                <Select value={cfg.tts.provider} onChange={setTtsProvider} options={providersFor("tts")} />
              </Field>
              <Field label="Model" findings={findingsFor(findings, "tts", "model")}>
                <Select value={cfg.tts.model} onChange={(v) => patch("tts", { model: v })} options={ttsModels} />
              </Field>
              <Field label="Voice" findings={findingsFor(findings, "tts", "voice")}>
                <Select
                  value={cfg.tts.voice}
                  onChange={(v) => patch("tts", { voice: v })}
                  options={voices}
                  invalidValues={markedVoices}
                  disabledValues={unusableVoices}
                />
              </Field>
            </div>
            <p className="mb-3 mt-5 text-xs font-medium">Voice Settings</p>
            <div className="grid gap-5 sm:grid-cols-2">
              <Slider
                label="Stability"
                value={cfg.tts.stability}
                onChange={(v) => patch("tts", { stability: v })}
              />
              <Slider
                label="Similarity Boost"
                value={cfg.tts.similarityBoost}
                onChange={(v) => patch("tts", { similarityBoost: v })}
              />
            </div>
          </SectionCard>
        )}

        {tab === "Tools" && (
          <SectionCard
            title="Tools"
            icon={<ToolIcon className="h-3.5 w-3.5" />}
            status={sectionStatus(findings, "tools")}
          >
            <p className="mb-4 text-xs text-[var(--text-muted)]">
              Functions the agent can call during a conversation.
            </p>
            <div className="space-y-3">
              {cfg.tools.map((tool) => (
                <div key={tool.id} className="rounded-lg border border-[var(--border)] p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-medium">{tool.name}()</p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">{tool.description}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={tool.enabled}
                        aria-label={`Enable ${tool.name}`}
                        onClick={() =>
                          setCfg({
                            ...cfg,
                            tools: cfg.tools.map((t) =>
                              t.id === tool.id ? { ...t, enabled: !t.enabled } : t,
                            ),
                          })
                        }
                        className={`relative h-6 w-11 rounded-full transition
                          ${tool.enabled ? "bg-[var(--brand)]" : "bg-[var(--border-strong)]"}`}
                      >
                        <span
                          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform
                            ${tool.enabled ? "translate-x-[22px]" : "translate-x-0.5"}`}
                        />
                      </button>
                      <button
                        onClick={() =>
                          setCfg({ ...cfg, tools: cfg.tools.filter((t) => t.id !== tool.id) })
                        }
                        aria-label={`Remove ${tool.name}`}
                        className="text-[var(--text-subtle)] transition hover:text-[var(--danger)]"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <pre className="mt-3 overflow-x-auto rounded-md bg-[var(--surface-muted)] p-2.5 font-mono text-[11px] text-[var(--text-muted)]">
                    {tool.params}
                  </pre>
                  {findingsFor(findings, "tools", `tools.${tool.id}`).map((f, i) => (
                    <p
                      key={`${f.id}-${i}`}
                      className="mt-2 flex items-start gap-1.5 text-[11px] text-[var(--danger)]"
                    >
                      <span aria-hidden="true">✕</span>
                      <span>{f.message}</span>
                    </p>
                  ))}
                </div>
              ))}
            </div>
            <button
              onClick={() =>
                setCfg({
                  ...cfg,
                  tools: [
                    ...cfg.tools,
                    {
                      id: `tool_${Date.now()}`,
                      name: "new_tool",
                      description: "Describe what this tool does.",
                      enabled: false,
                      params: "{ }",
                    },
                  ],
                })
              }
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border-strong)] px-3 py-2.5 text-xs font-medium text-[var(--text-muted)] transition hover:border-[var(--brand)] hover:text-[var(--brand)]"
            >
              <PlusIcon className="h-4 w-4" />
              Add Tool
            </button>
          </SectionCard>
        )}

        {tab === "Advanced" && (
          <SectionCard title="Advanced" status={sectionStatus(findings, "advanced")}>
            <div className="space-y-5">
              <div>
                <Toggle
                  label="Allow Interruptions"
                  hint="Let the caller barge in while the agent is speaking."
                  checked={cfg.advanced.interruptionEnabled}
                  onChange={(v) => patch("advanced", { interruptionEnabled: v })}
                />
                {findingsFor(findings, "advanced", "interruptionEnabled").map((f, i) => (
                  <p
                    key={`${f.id}-${i}`}
                    className="mt-2 flex items-start gap-1.5 text-[11px] text-[var(--warning)]"
                  >
                    <span aria-hidden="true">⚠</span>
                    <span>{f.message}</span>
                  </p>
                ))}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Endpointing (ms)">
                  <TextInput
                    type="number"
                    value={cfg.advanced.endpointingMs}
                    onChange={(v) => patch("advanced", { endpointingMs: Number(v) })}
                  />
                </Field>
                <Field label="Webhook URL">
                  <TextInput
                    value={cfg.advanced.webhookUrl}
                    placeholder="https://example.com/webhook"
                    onChange={(v) => patch("advanced", { webhookUrl: v })}
                  />
                </Field>
              </div>
              <Field label="Fallback Message">
                <textarea
                  className="field-input min-h-[80px] resize-y"
                  value={cfg.advanced.fallbackMessage}
                  onChange={(e) => patch("advanced", { fallbackMessage: e.target.value })}
                />
              </Field>
            </div>
          </SectionCard>
        )}
      </div>
    </div>
  );
}
