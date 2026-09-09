/**
 * The voice server.
 *
 * A separate process from Next, because a phone call is a long-lived stateful
 * media stream and Next's route handlers cannot hold a WebSocket — nor can
 * Vercel, which is where the app itself is headed. Next keeps the UI and the
 * config; this keeps the audio.
 *
 * Two surfaces:
 *   ws   /ws/call     media, for the browser harness today and Twilio later
 *   http /internal/*  control plane, called by the Next API routes
 */

import { loadEnv } from "../lib/env";

// Before anything reads a provider key.
loadEnv();

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import { BrowserTransport } from "../lib/call/browser-transport";
import { CallSession, type CallState, type TurnRecord } from "../lib/call/session";
import * as registry from "../lib/call/registry";
import { callStats, formatCallStats } from "../lib/call/stats";
import * as store from "../lib/store/calls";
import { getAgentConfig } from "../app/lib/config";
import { DEFAULT_CONFIG, type AgentConfig } from "../app/lib/types";

/*
 * PORT is what most hosts (Render, Railway, Fly) inject and expect the process
 * to bind; VOICE_PORT stays as the local-dev name so `npm run dev` is
 * unchanged. Host wins when both are set, because refusing the assigned port
 * is how a deploy silently fails its health check.
 */
const PORT = Number(process.env.PORT ?? process.env.VOICE_PORT ?? 3001);

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);

  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    // The Next app is a different origin once deployed.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });

  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) chunks.push(chunk as Buffer);

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "OPTIONS") return json(res, 204, {});

  if (url.pathname === "/internal/health") {
    return json(res, 200, { ok: true, active: registry.activeCount() });
  }

  if (url.pathname === "/internal/calls" && req.method === "GET") {
    const id = url.searchParams.get("id");

    if (id) {
      const call = await store.getCall(id);
      return call
        ? json(res, 200, { call })
        : json(res, 404, { error: "No such call." });
    }

    const limit = Number(url.searchParams.get("limit") ?? 50);
    return json(res, 200, { calls: await store.listCalls(limit) });
  }

  // Place an outbound call: register the intent, to be claimed on connect.
  if (url.pathname === "/internal/calls/outbound" && req.method === "POST") {
    const body = await readJson(req);

    const to = typeof body.to === "string" ? body.to : "";
    const agentId = typeof body.agentId === "string" ? body.agentId : "default-agent";
    const greeting = typeof body.greeting === "string" ? body.greeting : undefined;

    if (!to.trim()) {
      return json(res, 400, { error: "A destination `to` is required." });
    }

    const config = await resolveConfig(agentId, body.config as AgentConfig | undefined);
    const id = randomUUID();

    registry.addPending({ id, to, agentId, config, greeting, createdAt: Date.now() });

    return json(res, 200, {
      call: { id, to, agentId, status: "pending" },
      // Today the harness answers. With Twilio, this is where the REST call
      // to /Calls.json would go, and the SID would replace this id.
      note: "Waiting for the harness to answer. Open the call page.",
    });
  }

  if (url.pathname === "/internal/calls/pending" && req.method === "GET") {
    return json(res, 200, { pending: registry.listPending() });
  }

  json(res, 404, { error: "Not found." });
});

// ---------------------------------------------------------------------------
// Media plane
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname !== "/ws/call") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    void handleCall(ws, url);
  });
});

async function resolveConfig(
  agentId: string,
  supplied?: AgentConfig,
): Promise<AgentConfig> {
  if (supplied) return supplied;

  try {
    return (await getAgentConfig(agentId)) ?? DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Per-connection provider overrides, for testing.
 *
 * Swapping one leg of the pipeline without editing the saved config makes it
 * easy to isolate a provider — and to keep working when one of them is rate
 * limited, which on free tiers happens more than you would like.
 */
function applyOverrides(cfg: AgentConfig, url: URL): AgentConfig {
  const stt = url.searchParams.get("stt");
  const tts = url.searchParams.get("tts");
  const llm = url.searchParams.get("llm");

  if (!stt && !tts && !llm) return cfg;

  const next: AgentConfig = {
    ...cfg,
    stt: { ...cfg.stt },
    llm: { ...cfg.llm },
    tts: { ...cfg.tts },
  };

  if (stt === "sarvam") {
    next.stt = { provider: "sarvam", model: "saaras:v3", language: cfg.stt.language };
  } else if (stt === "gemini") {
    next.stt = { provider: "gemini", model: "gemini-3.5-transcribe", language: cfg.stt.language };
  }

  if (tts === "cartesia") {
    next.tts = { ...cfg.tts, provider: "cartesia", model: "sonic-2", voice: "Sophie" };
  } else if (tts === "elevenlabs") {
    next.tts = { ...cfg.tts, provider: "elevenlabs", model: "eleven_flash_v2_5", voice: "Sarah" };
  }

  if (llm === "groq") {
    next.llm = { ...cfg.llm, provider: "groq", model: "openai/gpt-oss-20b" };
  }

  return next;
}

async function handleCall(ws: WebSocket, url: URL): Promise<void> {
  // An outbound call already has an agent and a greeting waiting for it; an
  // inbound one is configured from the query. Everything after this differs
  // only in those two values.
  const wanted = url.searchParams.get("callId") ?? undefined;
  const pending = registry.claimPending(wanted);

  const direction = pending ? "outbound" : "inbound";
  const agentId = pending?.agentId ?? url.searchParams.get("agentId") ?? "default-agent";
  const base = pending?.config ?? (await resolveConfig(agentId));
  const config = applyOverrides(base, url);
  const id = pending?.id ?? randomUUID();

  // Dev-only network impairment, so buffering bugs surface here rather than
  // on a real call.
  const jitterMs = Number(url.searchParams.get("jitter") ?? 0);
  const loss = Number(url.searchParams.get("loss") ?? 0);

  const transport = new BrowserTransport(id, ws, { jitterMs, loss });

  await store.startCall({
    id,
    direction,
    transport: "browser",
    agentId,
    agentName: config.name,
    to: pending?.to,
  });

  const session = new CallSession({
    transport,
    config,
    direction,
    greeting: pending?.greeting,
    hooks: {
      onState: (state: CallState) => transport.sendControl({ type: "state", value: state }),
      onVad: (r) => transport.sendControl({ type: "vad", ...r }),
      onTurn: (turn: TurnRecord) => {
        store.addTurn(id, turn);
        transport.sendControl({
          type: "transcript",
          role: turn.role,
          text: turn.text,
          interrupted: turn.interrupted,
          toolsUsed: turn.toolsUsed,
          sttMs: turn.sttMs,
          llmMs: turn.llmMs,
          toolMs: turn.toolMs,
          ttsMs: turn.ttsMs,
        });
      },
      onError: (message) => {
        console.error(`[call ${id.slice(0, 8)}] ${message}`);
        store.failCall(id, message);
        transport.sendControl({ type: "error", message });
      },
      onEnded: () => {
        registry.unregister(id);

        // Latency is the feature on a phone call, so every call reports how it
        // actually performed rather than leaving it to be reconstructed from
        // per-turn lines scattered up the log.
        void store.endCall(id).then((record) => {
          const short = id.slice(0, 8);

          if (!record) {
            console.log(`[call ${short}] ended`);
            return;
          }

          const seconds = record.endedAt
            ? ((record.endedAt - record.startedAt) / 1000).toFixed(1)
            : "?";

          const stats = callStats(record.turns);
          const summary = formatCallStats(stats);

          console.log(
            `[call ${short}] ended after ${seconds}s, ${stats.turns} measured turn(s)`,
          );

          if (summary) console.log(summary);
        });
      },
    },
  });

  registry.register(session);

  // Let the harness know which call it answered before any audio flows.
  transport.sendControl({
    type: "connected",
    callId: id,
    direction,
    agent: config.name,
    to: pending?.to,
  });

  // Live tuning from the harness, so endpointing and interruption can be felt
  // without restarting a call.
  transport.onParams((patch) => {
    session.updateParams({
      endpointingMs:
        typeof patch.endpointingMs === "number" ? patch.endpointingMs : undefined,
      silenceTimeout:
        typeof patch.silenceTimeout === "number" ? patch.silenceTimeout : undefined,
      interruptionEnabled:
        typeof patch.interruptionEnabled === "boolean"
          ? patch.interruptionEnabled
          : undefined,
    });
  });

  console.log(
    `[call ${id.slice(0, 8)}] ${direction} started — agent "${config.name}"` +
      ` (stt ${config.stt.provider}, llm ${config.llm.provider}, tts ${config.tts.provider})`,
  );

  try {
    await session.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start call.";
    console.error(`[call ${id.slice(0, 8)}] start failed: ${message}`);
    store.failCall(id, message);
    transport.sendControl({ type: "error", message });
  }
}

server.listen(PORT, () => {
  console.log(`voice server listening on :${PORT}`);

  /*
   * Print the externally reachable URL when the host tells us what it is
   * (Render sets RENDER_EXTERNAL_URL), otherwise localhost. Logging
   * "localhost" on a deployed box is actively misleading when you are trying
   * to work out which URL the browser should be pointed at.
   */
  const external = process.env.RENDER_EXTERNAL_URL;

  if (external) {
    const host = external.replace(/^https?:\/\//, "").replace(/\/$/, "");
    console.log(`  ws   wss://${host}/ws/call`);
    console.log(`  http ${external.replace(/\/$/, "")}/internal/health`);
  } else {
    console.log(`  ws   ws://localhost:${PORT}/ws/call`);
    console.log(`  http http://localhost:${PORT}/internal/health`);
  }
});
