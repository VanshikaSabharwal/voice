/**
 * LLM turn. Takes the active agent config plus conversation history, calls the
 * configured provider, runs any tool calls, and returns the assistant's reply.
 *
 * The provider/model come from the user's Settings — this is where the config
 * and validation work pays off.
 */

import { keyFor } from "../../lib/providers/env";
import { findModel } from "../../lib/capabilities";
import { getAgentConfig } from "../../lib/config";
import { executeTool, TOOL_SCHEMAS } from "../../lib/tools";
import type { AgentConfig, ChatTurn } from "../../lib/types";

export const dynamic = "force-dynamic";

/** Cap tool round-trips so a confused model cannot loop forever. */
const MAX_TOOL_ROUNDS = 4;

function systemPromptFor(cfg: AgentConfig): string {
  const base = cfg.llm.systemPrompt?.trim() || cfg.systemPrompt;
  // Voice replies must stay short — long paragraphs are painful to listen to.
  return `${base}\n\nYou are speaking on a voice call. Keep replies under 40 words, conversational, and never use markdown, bullet points or emoji. Ask one question at a time.`;
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
): Promise<{ text: string; toolsUsed: string[] }> {
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    cfg.llm.model,
  )}:generateContent?key=${encodeURIComponent(key)}`;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
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
      contents.push({
        role: "user",
        parts: calls.map((p) => {
          const fc = p.functionCall!;
          toolsUsed.push(fc.name);
          return {
            functionResponse: {
              name: fc.name,
              response: executeTool(fc.name, fc.args ?? {}),
            },
          };
        }),
      });
      continue;
    }

    const text = parts
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    return { text, toolsUsed };
  }

  return { text: "Sorry, I could not complete that request.", toolsUsed };
}

// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  let body: { config?: AgentConfig; messages?: ChatTurn[] };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

const history = Array.isArray(body.messages) ? body.messages : [];

if (history.length === 0) {
  return Response.json(
    { error: "A non-empty messages array is required." },
    { status: 400 },
  );
}

// Prefer the config the client is actually running, so switching preset in the
// sidebar drives the LLM the same way it already drives STT and TTS. Fall back
// to the stored config for callers that post only messages.
const cfg = body.config ?? (await getAgentConfig("default-agent"));

if (!cfg) {
  return Response.json(
    { error: "No saved agent configuration found." },
    { status: 404 },
  );
}

  // The config now arrives from the client, so the model must be one this app
  // actually offers — never an arbitrary string interpolated into the API URL.
  if (!findModel("llm", cfg.llm.provider, cfg.llm.model)) {
    return Response.json(
      {
        error: `${cfg.llm.model} is not an available model for ${cfg.llm.provider}.`,
      },
      { status: 400 },
    );
  }

  const key = keyFor(cfg.llm.provider);
  if (!key) {
    return Response.json(
      { error: `No API key configured for ${cfg.llm.provider}.` },
      { status: 400 },
    );
  }

  try {
    const result = await runGemini(cfg, history, key);

    if (!result.text) {
      return Response.json(
        { error: "The model returned an empty reply." },
        { status: 502 },
      );
    }

    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chat failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
