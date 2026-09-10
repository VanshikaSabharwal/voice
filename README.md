# Voice Agent

A telephony voice agent: a continuous phone-style call with real turn-taking
and interruption, ready to point at Twilio.

The browser page at `/` is a harness standing in for a phone — it speaks the
same 8 kHz mu-law the carrier will, so what you hear locally is what a real
call sounds like.

Every layer is swappable — STT, LLM, TTS and tools are chosen in Settings, not
hardcoded.

---

## Requirements

- **Node 20+** (the engine uses `AbortSignal.any`)
- API keys for whichever providers you enable

## Install

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local`. You do **not** need all of them — one per layer is enough:

| Key | Used for | Notes |
|---|---|---|
| `GROQ_API_KEY` | LLM | **Recommended.** ~0.6s per call |
| `GOOGLE_API_KEY` | LLM + STT + embeddings | Also powers RAG. Slow with tools (~18s) |
| `SARVAM_API_KEY` | STT + TTS | Indic. Fastest STT measured here (~375ms) |
| `CARTESIA_API_KEY` | TTS | **Recommended.** ~180ms to first audio |
| `ELEVENLABS_API_KEY` | TTS | ~310ms to first audio |
| `BODHAN_API_KEY` | STT + TTS | 27 Indian languages incl. Bhojpuri, Bhili |

A minimal working set: `GROQ_API_KEY` + `CARTESIA_API_KEY` + one STT key.
`GOOGLE_API_KEY` is additionally required for RAG, which embeds through Gemini.

Measure any combination with `npm run verify:latency`.

## Run

```bash
npm run dev
```

Starts **two processes**:

| | Port | |
|---|---|---|
| Next.js | 3000 | UI, settings, API routes |
| Voice server | 3001 | WebSocket media for calls |

They are separate because a phone call is a long-lived stateful audio stream,
which Next route handlers (and Vercel) cannot hold.

```bash
npm run dev:next     # UI only
npm run dev:voice    # voice server only
```

Then open <http://localhost:3000>.

---

## Evaluation

`/evaluate` compares providers one layer at a time — STT, TTS or LLM in
isolation — on **latency, quality and cost**. `/evaluate/agent` shows where a
whole voice-agent turn spends its time.

### Spending

Every component run makes real API calls billed to your own provider accounts,
so the platform is built so that cannot happen by accident:

- The plan — how many calls, and what they will cost — is shown **before** the
  Run button, and refreshes on every change. Asking is free.
- `POST /api/eval/run` refuses without `confirm: true`, so a client that never
  showed the plan cannot spend anything. A `GET` is a 405: no link, prefetch or
  address bar can start a run.
- Nothing retries. A failed provider is reported as failed rather than charged
  for twice.
- Repetitions are capped at 10, because cost is linear in that number.
- `/evaluate/agent` reads recorded call history and costs nothing at all.

Two places where a run costs more than it looks, both stated in the plan:
evaluating **STT** synthesizes its test utterance first (a billed TTS call),
and scoring **TTS** quality transcribes the audio back (a billed STT call).

### What quality means

STT is scored by **word error rate** against the reference text — the count of
substitutions, deletions and insertions needed to reach the transcript, over the
reference length. The alignment is Needleman-Wunsch rather than a positional
comparison, because one dropped word shifts every later word and a positional
diff would report the whole remainder as wrong.

TTS quality is a round trip: synthesize, transcribe the result, and compare to
what was asked for. It measures intelligibility, not naturalness — a voice can
be robotic and still score perfectly.

LLM output has no single correct answer, so it carries latency only.

### Cost

`lib/eval/pricing.ts` ships with **no rates filled in**. Vendor pricing changes
without notice and a stale figure would quietly skew every comparison, so
unknown is recorded as unknown and the UI shows "—" rather than `$0.00`. Add
rates from each provider's pricing page along with the date you checked.

### Verifying it

```bash
npm run verify:wer     # word error rate — pure computation
npm run verify:eval    # runner logic against stubbed providers
```

Neither makes a provider call, so both are free to run. What they cannot check
is whether the live providers behave as their adapters expect — only a real run
shows that, and a real run costs money.

---

## Testing

### 1. Audio primitives — no servers, no keys

```bash
npm run verify:audio
```

Checks the mu-law codec against **ITU G.711 reference vectors**, plus framing
and playback pacing. Run this first if audio ever sounds wrong — it isolates
the codec from everything else.

### 2. TTS providers — needs keys

```bash
npm run verify:tts
```

Confirms each provider emits correctly framed 8 kHz mu-law and reports
time-to-first-byte.

### 3. A headless call — needs the voice server running

`npm run call` is a robot caller: it synthesizes speech, streams it over the
same protocol the browser uses, and prints what the agent heard and said. A
failure here is an engine bug rather than a microphone one, which is what makes
it worth having.

```bash
# Fastest path — preset defaults, no env vars needed
npm run call

# Your own utterance
npm run call -- "what is the status of S R one two three four"

# Interrupt the agent mid-greeting (barge-in)
npm run call -- "actually, my billing is wrong" --barge-in

# Hindi end to end
AGENT_ID=hindi-support STT_PROVIDER=sarvam npm run call -- "मेरा बिल गलत है"

# Compare TTS latency (~310ms vs ~200ms to first audio)
TTS_PROVIDER=elevenlabs npm run call

# Pin every layer
LLM_PROVIDER=groq TTS_PROVIDER=cartesia STT_PROVIDER=sarvam npm run call
```

Two things worth knowing:

- **Say IDs as digits** — "S R one two three four", not "SR1234". TTS reads the
  latter as "one thousand two hundred thirty-four", which STT then transcribes
  as words rather than a request ID.
- **Non-English text picks an Indic voice automatically**, detected from the
  script. Override with `CALLER_LANG=hi`. Without this the caller's own voice
  mispronounces Devanagari and a healthy agent looks broken.

### 4. A real call — your voice

<http://localhost:3000> → **Call**.

The agent greets you, then listens. Try talking over it to feel barge-in.

The **VAD meter** is the thing to watch: the bar is your voice level, the line
is the detection threshold. If speech never crosses the line, that is why the
agent is not hearing you — and it is nearly always the cause.

Live sliders during a call: endpointing, barge-in on/off, echo cancellation.

Past calls with transcripts and per-stage timings: <http://localhost:3000/conversations>

---

## Configuration

Four ways, highest precedence first:

**1. Env overrides** — per test run, no files touched:

| Variable | Values |
|---|---|
| `STT_PROVIDER` | `sarvam` · `gemini` |
| `LLM_PROVIDER` | `groq` |
| `TTS_PROVIDER` | `cartesia` · `elevenlabs` |
| `AGENT_ID` | `customer-support` · `hindi-support` · `default-agent` |

Unrecognized values fall through silently to the config. These replace the
model as well as the provider, and the list is deliberately short — it is a
debugging affordance, not a config system.

**2. Saved configs** — <http://localhost:3000/settings>, written to
`.data/configs.json`.

**3. Presets** — [`app/lib/presets.ts`](app/lib/presets.ts), shipped in code and
read-only. `customer-support` is tuned for telephony (Groq + Cartesia).

**4. `DEFAULT_CONFIG`** — [`app/lib/types.ts`](app/lib/types.ts).

Presets ship in code; saved configs do not. A saved config will keep using
whatever providers it was saved with.

### Fields that matter for calls

Under Settings → General / Advanced. These had no effect until the telephony
engine existed:

| Field | Effect |
|---|---|
| `advanced.endpointingMs` | Silence that ends a turn. **The main latency knob.** |
| `general.silenceTimeout` | Nothing said at all → re-prompt |
| `advanced.interruptionEnabled` | Barge-in on/off |
| `general.maxDuration` | Hard cap on one utterance |
| `general.vad` | `"enabled"`, or a fixed window for debugging |

---

## How it works

Both call directions are one engine — they differ only in who opened the
socket:

```
outbound intent ─┐
                 ├─▶ CallSession ─▶ MediaTransport ─▶ browser / Twilio
inbound connect ─┘   VAD → STT → LLM → TTS
```

States: `greeting → listening → capturing → thinking → speaking → …`

Everything on the wire is **8 kHz mono mu-law in 20 ms frames** — what the
phone network actually carries. The browser harness speaks it too, so the
narrowband quality hit shows up immediately rather than on Twilio day.

Both ElevenLabs and Cartesia emit mu-law directly, so there is **no ffmpeg and
no audio decoding** anywhere.

### Measured latency

Sarvam STT + Groq + Cartesia, one turn including a tool call:

| Stage | |
|---|---|
| STT | ~520 ms |
| LLM | ~1400 ms |
| TTS (first audio) | ~200 ms |
| **Total** | **~2.1 s** |

---

## Layout

```
app/                    Next.js UI and API routes
  page.tsx              The call harness (VAD meter, live tuning)
  conversations/        Call history and transcripts
  settings/             Provider configuration
lib/                    Shared, framework-free (Node + browser)
  audio/                mu-law codec, framing, VAD
  call/                 CallSession, MediaTransport, registry
  agent/                STT, LLM, TTS
voice-server/           Standalone WebSocket media server
  TELEPHONY.md          Architecture + Twilio integration guide
scripts/                Verification and the headless caller
```

## Adding Twilio

Not wired up yet — see
[`voice-server/TELEPHONY.md`](voice-server/TELEPHONY.md). The engine already
speaks Twilio's wire format, so it is one new `MediaTransport` plus a TwiML
route; nothing under `lib/call/session.ts`, `lib/audio/` or `lib/agent/` should
need to change.

Note for Indian numbers: outbound to Indian mobiles requires DLT/TRAI
registration, which takes days to weeks. Worth starting before you need it.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ECONNREFUSED 127.0.0.1:3001` | Voice server not running — `npm run dev` |
| Call hangs at "thinking" | Slow or rate-limited LLM. Try `LLM_PROVIDER=groq` |
| `429 RESOURCE_EXHAUSTED` | Gemini free tier (25 req/model/day) |
| Agent does not hear you | Watch the VAD meter — speech must cross the threshold line |
| Agent interrupts itself | Turn echo cancellation on, or use headphones |
| Turn ends mid-sentence | Raise `endpointingMs` |
