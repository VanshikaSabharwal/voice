# Telephony engine

Two scenarios, one engine:

1. **Outbound** — the app calls a customer; the agent speaks first.
2. **Inbound** — a customer calls a number and reaches the agent.

After "call connected" these are identical, so there is one `CallSession` behind
a swappable `MediaTransport` rather than two implementations.

```
                     ┌──────────────────────────────────┐
 outbound intent ───▶ │  CallSession                     │
                     │   VAD → STT → LLM → TTS          │
 inbound connect ───▶ │   (interruptible throughout)     │
                     └───────────────┬──────────────────┘
                                     │ MediaTransport
                        ┌────────────┴────────────┐
                        │                         │
                 BrowserTransport          TwilioTransport
                 (browser harness)         (to be added)
```

Everything on the wire is **8 kHz mono mu-law in 20 ms frames** — 160 bytes,
50 a second. That is what the phone network carries, and the browser harness
speaks it too, deliberately: the narrowband quality hit shows up on day one
rather than on Twilio day.

## Running it

```bash
npm run dev          # Next on :3000 and the voice server on :3001
npm run dev:next     # UI only
npm run dev:voice    # voice server only
```

Then open <http://localhost:3000> and press Call.

### Testing without a browser

`scripts/fake-caller.ts` drives the same protocol headlessly, so a failure
there is an engine bug rather than an AudioWorklet one.

```bash
npm run call                                     # one exchange
npm run call -- "check my billing" --barge-in    # interrupt the greeting

# Swap one leg without editing the saved config — useful when a free tier
# rate-limits, which happens more than you would like.
STT_PROVIDER=sarvam LLM_PROVIDER=groq TTS_PROVIDER=cartesia npm run call
```

Also `npm run verify:audio` (mu-law against ITU reference vectors, framing,
pacing) and `npm run verify:tts` (live providers → correctly sized frames).

## Why no audio decoder

ElevenLabs (`?output_format=ulaw_8000`) and Cartesia
(`{container:"raw", encoding:"pcm_mulaw", sample_rate:8000}`) both emit mu-law
directly — verified against the live APIs, not just the docs. Provider bytes go
straight to the transport.

**No ffmpeg, no MP3 decoder, no Web Audio on the server.** Sarvam is the one
exception: WAV only, so that path parses and resamples.

## Measured latency

Sarvam STT + Groq + Cartesia, one full turn including a tool call:

| Stage | |
|---|---|
| STT | ~520 ms |
| LLM | ~1400 ms |
| TTS (first byte) | ~200 ms |
| **To first audio** | **~2.1 s** |

Cartesia is somewhat faster to first byte than ElevenLabs (~200 ms vs ~310 ms
via its /stream endpoint), which is worth having on a phone call.

## Configuration

Fields that existed in `AgentConfig` and the Settings UI but were never read by
any code — the browser page is push-to-talk, so there was no turn-taking to
configure — now take effect (`lib/call/params.ts`):

| Field | Effect |
|---|---|
| `general.vad` | `"enabled"` → VAD turn-taking; otherwise a fixed window (debugging) |
| `advanced.endpointingMs` | Silence that ends a turn. **The main latency knob.** |
| `general.silenceTimeout` | Nothing said at all → re-prompt. *Not* the same as endpointing. |
| `general.maxDuration` | Hard cap on one utterance |
| `advanced.interruptionEnabled` | Gates barge-in |
| `advanced.fallbackMessage` | Spoken when nothing was understood |

## Adding Twilio

The engine already speaks Twilio's wire format, so this is a protocol
translation. Nothing under `lib/call/session.ts`, `lib/audio/` or `lib/agent/`
should need to change — if it does, the abstraction leaked.

**1. `lib/call/twilio-transport.ts`** — implement `MediaTransport`:

| Twilio | Implementation |
|---|---|
| `start` event | Capture `streamSid`/`callSid` and `customParameters`. Only now is the transport ready. |
| `media` event | `Buffer.from(payload, "base64")`, keep `track === "inbound"` → `onAudio`. Already 160-byte frames. |
| `sendAudio` | `{event:"media", streamSid, media:{payload: base64}}` |
| `clearBuffer` | `{event:"clear", streamSid}` |
| `mark` | `{event:"mark", streamSid, mark:{name}}`; Twilio echoes it when the audio actually played |
| `stop` | → `onClose` |

**2. `app/api/twilio/voice/route.ts`** — inbound TwiML. A plain route handler,
no WebSocket, so Vercel is fine:

```xml
<Response>
  <Connect>
    <Stream url="wss://<voice-host>/ws/call">
      <Parameter name="agentId" value="default-agent"/>
    </Stream>
  </Connect>
</Response>
```

Must be `<Connect>`, not `<Start>` — `<Start>` is one-way, so `clear`, `mark`
and outbound media will not work. Validate `X-Twilio-Signature`.

**3. Outbound** — one `fetch` to
`https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls.json` with basic auth
and `To`/`From`/`Url`. The `twilio` npm package is not required. Replace the
pending-intent registration in `/internal/calls/outbound` with this; the
returned SID becomes the call id.

**4. Route the upgrade** in `voice-server/index.ts` — pick the transport by
query param or first-message shape.

### Until then

The browser harness is the stand-in, and imitates Twilio deliberately: whole
frames only, `mark` echoed on playback, and `?jitter=40&loss=0.01` to surface
buffering bugs before a real call does.

## Notes

- **`.data/calls.json` lives on the voice server.** Vercel's filesystem is
  read-only, so `app/api/calls` proxies rather than storing. Swap for a database
  before running more than one voice-server instance.
- **Echo cancellation matters.** Without it, laptop speakers feed the agent's
  own voice back and it interrupts itself. The harness toggle demonstrates this.
- **Gemini's free tier is 25 requests/model/day** and will throttle during
  testing. Groq and Sarvam have separate quotas.
