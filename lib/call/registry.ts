/**
 * Live sessions, plus the queue of outbound calls waiting to be answered.
 *
 * The pending queue is what makes an outbound call possible without a carrier:
 * the app "places" a call by registering an intent, and the harness picks it
 * up when it connects. With Twilio the same registration is keyed by call SID
 * and claimed when the media stream arrives — same structure, different key.
 */

import type { CallSession } from "./session";
import type { AgentConfig } from "../../app/lib/types";

export type PendingCall = {
  id: string;
  to: string;
  agentId: string;
  config: AgentConfig;
  greeting?: string;
  createdAt: number;
};

const sessions = new Map<string, CallSession>();
const pending = new Map<string, PendingCall>();

/** Outbound intents expire so an unanswered call cannot linger forever. */
const PENDING_TTL_MS = 10 * 60 * 1000;

export function register(session: CallSession): void {
  sessions.set(session.id, session);
}

export function unregister(id: string): void {
  sessions.delete(id);
}

export function get(id: string): CallSession | undefined {
  return sessions.get(id);
}

export function activeCount(): number {
  return sessions.size;
}

export function addPending(call: PendingCall): void {
  pending.set(call.id, call);
}

/** Take the oldest outbound call still waiting, if any. */
export function claimPending(id?: string): PendingCall | undefined {
  prune();

  if (id) {
    const exact = pending.get(id);

    if (exact) {
      pending.delete(id);
      return exact;
    }

    return undefined;
  }

  const [first] = [...pending.values()].sort((a, b) => a.createdAt - b.createdAt);

  if (first) pending.delete(first.id);

  return first;
}

export function listPending(): PendingCall[] {
  prune();
  return [...pending.values()];
}

function prune(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;

  for (const [id, call] of pending) {
    if (call.createdAt < cutoff) pending.delete(id);
  }
}
