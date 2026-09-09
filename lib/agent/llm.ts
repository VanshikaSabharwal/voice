/**
 * LLM turn, extracted from app/api/chat/route.ts so the HTTP route and the
 * call engine share one implementation.
 *
 * Unchanged in substance from the original: same providers, same tool loop,
 * same voice-oriented system prompt. The only additions are an AbortSignal
 * (a phone call can be interrupted mid-thought) and optional timing, which
 * the conversations view reports per turn.
 */

import { keyFor } from "../../app/lib/providers/env";
import { executeTool, TOOL_SCHEMAS } from "../../app/lib/tools";
import type { AgentConfig, ChatTurn } from "../../app/lib/types";
import { LLM_TIMEOUT_MS, describeFailure, withDeadline } from "./deadline";

/** Cap tool round-trips so a confused model cannot loop forever. */
const MAX_TOOL_ROUNDS = 4;

export type LlmResult = {
  text: string;
  toolsUsed: string[];
  /**
   * Wall-clock spent inside tool implementations, summed over every round.
   *
   * Separated from the enclosing llmMs because they are different problems
   * with different fixes: model time is a provider/model choice, while tool
   * time is our own retrieval and I/O. A turn that spends 6 s in RAG and 2 s
   * thinking looks identical to one that spends 8 s thinking unless the two
   * are measured apart.
   *
   * Concurrent calls within a round overlap, so this is elapsed time rather
   * than the sum of individual calls — it answers "how long did the caller
   * wait for tools", not "how much tool work happened".
   */
  toolMs?: number;
};

export function systemPromptFor(cfg: AgentConfig): string {
  const base = cfg.llm.systemPrompt?.trim() || cfg.systemPrompt;

  // Voice replies must stay short — long paragraphs are painful to listen to.
  let instruction =
    "You are speaking on a voice call. Keep replies under 40 words, conversational, and never use markdown, bullet points or emoji. Ask one question at a time.";

  // Name the language explicitly. A Hindi system prompt alone is not enough:
  // these instructions are in English, and the model tends to answer in the
  // language it was last addressed in — which then gets spoken by a TTS voice
  // configured for a different one.
  const language = (cfg.language || "en").split("-")[0];

  if (language !== "en") {
    const NAMES: Record<string, string> = {
      hi: "Hindi",
      ta: "Tamil",
      te: "Telugu",
      mr: "Marathi",
      bn: "Bengali",
    };

    const name = NAMES[language] ?? language;
    instruction += ` Always reply in ${name}, regardless of the language the caller uses.`;
  }

  return `${base}\n\n${instruction}`;
}

function enabledTools(cfg: AgentConfig): string[] {
  return cfg.tools.filter((t) => t.enabled && TOOL_SCHEMAS[t.name]).map((t) => t.name);
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};

type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

async function runGemini(
  cfg: AgentConfig,
  history: ChatTurn[],
  key: string,
  signal?: AbortSignal,
): Promise<LlmResult> {
  const names = enabledTools(cfg);
  const tools =
    names.length > 0
      ? [
          {
            functionDeclarations: names.map((name) => ({
              name,
              description: TOOL_SCHEMAS[name].description,
              parameters: TOOL_SCHEMAS[name].parameters,
            })),
          },
        ]
      : undefined;

  const contents: GeminiContent[] = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const toolsUsed: string[] = [];
  let toolMs = 0;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    cfg.llm.model,
  )}:generateContent?key=${encodeURIComponent(key)}`;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: withDeadline(signal, LLM_TIMEOUT_MS),
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPromptFor(cfg) }] },
        generationConfig: {
          temperature: cfg.llm.temperature,
          maxOutputTokens: cfg.llm.maxTokens,
          topP: cfg.llm.topP,
        },
        ...(tools ? { tools } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini ${res.status}: ${detail.slice(0, 200)}`);
    }

    const data = await res.json();
    const parts: GeminiPart[] = data.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);

    if (calls.length > 0) {
      contents.push({ role: "model", parts });

      // Run the round's calls concurrently: a model asking for two lookups at
      // once should not pay for them serially while the caller waits.
      const toolStart = Date.now();

      const responses = await Promise.all(
        calls.map(async (p) => {
          const fc = p.functionCall!;
          toolsUsed.push(fc.name);
          return {
            functionResponse: {
              name: fc.name,
              response: await executeTool(fc.name, fc.args ?? {}),
            },
          };
        }),
      );

      // Elapsed, not summed: the calls above overlapped.
      toolMs += Date.now() - toolStart;

      contents.push({ role: "user", parts: responses });
      continue;
    }

    const text = parts
      .map((p) => p.text ?? "")
      .join("")
      .trim();

    return { text, toolsUsed, toolMs };
  }

  return { text: "Sorry, I could not complete that request.", toolsUsed, toolMs };
}

// ---------------------------------------------------------------------------
// Groq (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
};

async function runGroq(
  cfg: AgentConfig,
  history: ChatTurn[],
  key: string,
  signal?: AbortSignal,
): Promise<LlmResult> {
  const names = enabledTools(cfg);
  const tools =
    names.length > 0
      ? names.map((name) => ({
          type: "function" as const,
          function: {
            name,
            description: TOOL_SCHEMAS[name].description,
            parameters: TOOL_SCHEMAS[name].parameters,
          },
        }))
      : undefined;

  // OpenAI-style: the system prompt is a message, not a separate field.
  const messages: OpenAIMessage[] = [
    { role: "system", content: systemPromptFor(cfg) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  const toolsUsed: string[] = [];
  let toolMs = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: withDeadline(signal, LLM_TIMEOUT_MS),
      body: JSON.stringify({
        model: cfg.llm.model,
        messages,
        temperature: cfg.llm.temperature,
        max_tokens: cfg.llm.maxTokens,
        top_p: cfg.llm.topP,
        frequency_penalty: cfg.llm.frequencyPenalty,
        presence_penalty: cfg.llm.presencePenalty,
        ...(tools ? { tools, tool_choice: "auto" } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Groq ${res.status}: ${detail.slice(0, 200)}`);
    }

    const data = await res.json();
    const message: OpenAIMessage | undefined = data.choices?.[0]?.message;
    const calls = message?.tool_calls ?? [];

    if (calls.length > 0) {
      // The assistant turn carrying the calls must be echoed back verbatim,
      // then one tool message per call, matched by tool_call_id.
      messages.push(message!);

      // Concurrently, so two lookups in one round do not run serially while
      // the caller waits. Order is preserved by Promise.all.
      const toolStart = Date.now();

      const results = await Promise.all(
        calls.map(async (call) => {
          toolsUsed.push(call.function.name);

          // Arguments arrive as a JSON string; a malformed one must not throw.
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            args = {};
          }

          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: JSON.stringify(await executeTool(call.function.name, args)),
          };
        }),
      );

      // Elapsed, not summed: the calls above overlapped.
      toolMs += Date.now() - toolStart;

      messages.push(...results);
      continue;
    }

    return { text: (message?.content ?? "").trim(), toolsUsed, toolMs };
  }

  return { text: "Sorry, I could not complete that request.", toolsUsed, toolMs };
}

// ---------------------------------------------------------------------------

/** Run one LLM turn against the configured provider. */
export async function runAgent(
  cfg: AgentConfig,
  history: ChatTurn[],
  signal?: AbortSignal,
): Promise<LlmResult> {
  const key = keyFor(cfg.llm.provider, "llm");

  if (!key) {
    throw new Error(`No API key configured for ${cfg.llm.provider}.`);
  }

  try {
    return await (cfg.llm.provider === "groq"
      ? runGroq(cfg, history, key, signal)
      : runGemini(cfg, history, key, signal));
  } catch (err) {
    // A caller-driven abort is an interruption, not a fault — let it through
    // untouched so the session can tell the two apart.
    if (err instanceof Error && err.name === "AbortError" && signal?.aborted) {
      throw err;
    }

    throw new Error(describeFailure(err, cfg.llm.provider, "chat"));
  }
}
