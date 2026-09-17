# Voice Agent

A telephony voice agent: a continuous phone-style call with real turn-taking
and interruption, ready to point at Twilio.

The browser page at `/playground` is a harness standing in for a phone — it speaks the
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

Then open <http://localhost:3000>. You will land on the sign-in page; the
voice harness lives at `/playground` once you are signed in as an admin.

---

## Reading Assessment

A second application shares this codebase: children read book pages aloud and
are scored on how accurately they read them.

Sign in at `/login`. Pick a role first — student, teacher or administrator —
then sign in through that role's form. The role is verified against the
account, so an administrator's password will not get you in through the
Teacher door.

On a fresh database an administrator is seeded on the first login attempt, and
only that form is prefilled:

| | |
|---|---|
| Email | `admin@example.com` |
| Password | `password` |

**Change that password before deploying anywhere real.**

Three roles, each with one job:

| Role | Can |
|---|---|
| Admin | Add books and pages, create assessments, create teacher and student accounts |
| Teacher | Assign assessments to their own students, see results and marksheets |
| Student | Read assigned pages aloud, see their report card |

Adding a page: upload the page image, then press **Read text from image** to
pull the words off it — optionally with an instruction such as "only the story
text, skip the caption". The result is filled into the text box for you to
correct before saving. Typing the text by hand still works.

The text cannot be blank, image or not: it is what each spoken word is aligned
against, so a page without it would score 0% however well the child reads.
Reading text from an image makes one Gemini call and needs `GOOGLE_API_KEY`;
`READING_OCR_MODEL` overrides the model.

The flow: an admin adds a book and supplies each page's text, creates an
assessment over those pages, and creates accounts. A teacher assigns the
assessment to their students. A child opens the page, reads it aloud, and the
words light up as they go — green for correct, amber for a misread word, red
for a skipped one. A page is passed at **90% word accuracy** by default, which
each assessment can override.

### How the scoring works

Speech is recorded in ~5 second chunks and transcribed through whichever STT
provider is configured in Settings. The transcript is then aligned against the
page text with Needleman-Wunsch, which is what makes a skipped word register as
one omission rather than knocking every later word out of position:

```
page text:  The  cat  sat  on  the  mat
transcript: The  cat  sit  on  a   mat
             ok   ok  SUB  ok  SUB  ok    ->  4/6 = 66.7%
```

Accuracy is correct words over words *on the page*, so skipping counts against
a child exactly as much as misreading. Extra words (repeats, self-corrections)
are reported but kept out of the denominator. Fluency is correct words per
minute.

The browser runs the same alignment live for feedback, but the score that
decides whether a page is passed is always recomputed on the server from the
page text — a client cannot report its own result.

### Environment

| Key | Used for | Notes |
|---|---|---|
| `SESSION_SECRET` | Signing session cookies | **Required in production.** `openssl rand -hex 32` |
| `MONGODB_URL` | Storage | Already used by the voice agent; falls back to `.data/*.json` |
| `BLOB_READ_WRITE_TOKEN` | Page images | **Required in production.** Without it images go to `public/uploads`, which does not survive a deploy |
| `READING_STT_PROVIDER` | STT override | Optional. Defaults to the provider chosen in Settings |
| `READING_STT_MODEL` | STT override | Optional, required alongside the provider |
| `READING_STT_LANGUAGE` | STT language | Optional. Defaults to `en-IN` |

### Page images

Images go to [Vercel Blob](https://vercel.com/docs/vercel-blob) when
`BLOB_READ_WRITE_TOKEN` is set, and to `public/uploads` otherwise — so local
development needs no cloud account, and only the returned URL is ever stored on
the page record. Neither the database nor the UI knows which backend served it.

Set it up once: **Vercel dashboard → Storage → Create → Blob**, choose
**Public** access (required — these URLs are embedded directly in `<img>`
tags; a private store will reject uploads), connect it to the project, then
`vercel env pull` to get the token locally. Ensure Production has
`BLOB_READ_WRITE_TOKEN` set to that store's token.

Uploads are capped at **4 MB**, just under Vercel's 4.5 MB function request
limit. That limit is enforced by the platform before the handler runs, so a
larger file would fail as an opaque 413 rather than a message anyone could act
on; staying under it means the rejection comes with an explanation. If page
scans ever need to be bigger, Vercel Blob's client-upload flow bypasses the
function entirely.

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

<http://localhost:3000/playground>.

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
