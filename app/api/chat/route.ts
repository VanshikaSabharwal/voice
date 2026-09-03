/**
 * LLM turn. Takes the active agent config plus conversation history, calls the
 * configured provider, runs any tool calls, and returns the assistant's reply.
 *
 * The provider/model come from the user's Settings — this is where the config
 * and validation work pays off.
 */

import { keyFor } from "../../lib/providers/env";
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
// OpenAI
// ---------------------------------------------------------------------------

type OpenAIMessage = {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

async function runOpenAI(
  cfg: AgentConfig,
  history: ChatTurn[],
  key: string,
): Promise<{ text: string; toolsUsed: string[] }> {
  const tools = enabledTools(cfg).map((name) => ({
    type: "function",
    function: {
      name,
      description: TOOL_SCHEMAS[name].description,
      parameters: TOOL_SCHEMAS[name].parameters,
    },
  }));

  const messages: OpenAIMessage[] = [
    { role: "system", content: systemPromptFor(cfg) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: cfg.llm.model,
        messages,
        temperature: cfg.llm.temperature,
        max_tokens: cfg.llm.maxTokens,
        top_p: cfg.llm.topP,
        frequency_penalty: cfg.llm.frequencyPenalty,
        presence_penalty: cfg.llm.presencePenalty,
        ...(tools.length > 0 ? { tools } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status}: ${detail.slice(0, 200)}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const msg: OpenAIMessage | undefined = choice?.message;
    if (!msg) throw new Error("OpenAI returned no message.");

    if (msg.tool_calls?.length) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // Malformed arguments still get a result so the loop can continue.
        }
        toolsUsed.push(call.function.name);
        const result = executeTool(call.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    return { text: msg.content?.trim() ?? "", toolsUsed };
  }

  return { text: "Sorry, I could not complete that request.", toolsUsed };
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

  const cfg = body.config;
  const history = Array.isArray(body.messages) ? body.messages : [];

  if (!cfg || history.length === 0) {
    return Response.json(
      { error: "config and a non-empty messages array are required." },
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
    const result =
      cfg.llm.provider === "gemini"
        ? await runGemini(cfg, history, key)
        : await runOpenAI(cfg, history, key);

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
