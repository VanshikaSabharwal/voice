/**
 * Call records and transcripts.
 *
 * Follows the .data/*.json approach already used for configs, with two
 * deliberate differences that matter once audio is involved:
 *
 *  - Writes are debounced and the active call is held in memory. Rewriting a
 *    growing JSON array on every turn, from inside a loop that must service a
 *    frame every 20 ms, is a good way to hear the event loop stall.
 *  - Writes are serialised through one promise chain. Two calls ending at the
 *    same moment would otherwise read-modify-write over each other and lose a
 *    transcript.
 *
 * This lives on the voice server, which has a real filesystem; Vercel's is
 * read-only, which is why the Next route proxies here rather than storing
 * anything itself.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TurnRecord } from "../call/session";
import type { CallDirection, TransportKind } from "../call/transport";

export type CallRecord = {
  id: string;
  direction: CallDirection;
  transport: TransportKind;
  agentId: string;
  agentName: string;
  from?: string;
  to?: string;
  startedAt: number;
  endedAt?: number;
  status: "active" | "completed" | "failed";
  turns: TurnRecord[];
  error?: string;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "calls.json");

/** Cap the log so a long-running server does not grow without bound. */
const MAX_RECORDS = 200;

const active = new Map<string, CallRecord>();

let cache: CallRecord[] | null = null;
let writeChain: Promise<void> = Promise.resolve();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<CallRecord[]> {
  if (cache) return cache;

  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    // Missing or unreadable simply means no calls yet.
    cache = [];
  }

  return cache;
}

/** Queue a write behind any already in flight. */
function enqueueWrite(): void {
  writeChain = writeChain.then(async () => {
    const records = await load();

    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(DATA_FILE, JSON.stringify(records, null, 2), "utf8");
    } catch (err) {
      console.error("[calls] write failed:", err);
    }
  });
}

function scheduleFlush(): void {
  if (flushTimer) return;

  flushTimer = setTimeout(() => {
    flushTimer = null;
    enqueueWrite();
  }, 2000);
}

export async function startCall(
  record: Omit<CallRecord, "turns" | "status" | "startedAt"> &
    Partial<Pick<CallRecord, "startedAt">>,
): Promise<CallRecord> {
  const entry: CallRecord = {
    ...record,
    startedAt: record.startedAt ?? Date.now(),
    status: "active",
    turns: [],
  };

  active.set(entry.id, entry);

  const records = await load();
  records.unshift(entry);

  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;

  scheduleFlush();
  return entry;
}

/** Record one turn. Held in memory; persisted on the next flush. */
export function addTurn(id: string, turn: TurnRecord): void {
  const record = active.get(id);

  if (!record) return;

  record.turns.push(turn);
  scheduleFlush();
}

export function failCall(id: string, error: string): void {
  const record = active.get(id);

  if (!record) return;

  record.error = error;
  scheduleFlush();
}

export async function endCall(id: string): Promise<void> {
  const record = active.get(id);

  if (!record) return;

  record.endedAt = Date.now();
  record.status = record.error ? "failed" : "completed";

  active.delete(id);

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  enqueueWrite();
  await writeChain;
}

export async function listCalls(limit = 50): Promise<CallRecord[]> {
  const records = await load();
  return records.slice(0, limit);
}

export async function getCall(id: string): Promise<CallRecord | undefined> {
  const records = await load();
  return records.find((r) => r.id === id);
}
