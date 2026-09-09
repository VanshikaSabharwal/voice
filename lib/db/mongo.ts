/**
 * MongoDB connection, shared by the Next app and the voice server.
 *
 * Persistence moved here because `.data/*.json` does not survive deployment:
 * Vercel's filesystem is read-only, and Render's is ephemeral — a container
 * restart or redeploy silently discards whatever was written. Both processes
 * also need the SAME configs, which two separate local files cannot give you.
 *
 * MONGODB_URL is optional. Without it every caller falls back to the original
 * file store, so `npm run dev` still works with no database running — the
 * fallback is what keeps local development from requiring infrastructure.
 */

import { MongoClient, type Db } from "mongodb";

/** Name is part of the URL for most providers; this is only the fallback. */
const DB_NAME = process.env.MONGODB_DB ?? "voice_agent";

export const COLLECTIONS = {
  configs: "configs",
  calls: "calls",
} as const;

/** Is a database configured at all? Decides file-store vs Mongo everywhere. */
export function mongoEnabled(): boolean {
  return Boolean(process.env.MONGODB_URL?.trim());
}

/*
 * One client per process, created lazily and reused.
 *
 * The promise itself is cached rather than the resolved client, so concurrent
 * first-callers share a single connection attempt instead of each opening
 * their own pool. In Next's dev server the module is re-evaluated on hot
 * reload, which would leak a pool per reload — hence the globalThis pin.
 */
type Cached = { client: MongoClient | null; promise: Promise<MongoClient> | null };

const globalForMongo = globalThis as unknown as { __mongo?: Cached };
const cached: Cached = globalForMongo.__mongo ?? { client: null, promise: null };
globalForMongo.__mongo = cached;

async function connect(): Promise<MongoClient> {
  const url = process.env.MONGODB_URL?.trim();

  if (!url) throw new Error("MONGODB_URL is not set.");

  if (cached.client) return cached.client;

  if (!cached.promise) {
    cached.promise = new MongoClient(url, {
      // A voice turn has a hard latency budget; failing fast and falling back
      // to the file store beats blocking the call on an unreachable database.
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      // Small pool: this is config reads and debounced call writes, not a
      // high-throughput workload.
      maxPoolSize: 10,
    })
      .connect()
      .then((client) => {
        cached.client = client;
        return client;
      })
      .catch((err) => {
        // Clear the cached promise so a later call can retry rather than
        // being permanently poisoned by one failed attempt at startup.
        cached.promise = null;
        throw err;
      });
  }

  return cached.promise;
}

export async function getDb(): Promise<Db> {
  const client = await connect();
  return client.db(DB_NAME);
}

/**
 * Try to get a database, or null if unavailable.
 *
 * Callers use this to degrade to the file store rather than failing: a config
 * read that throws would take down a call, and losing persistence is a much
 * smaller problem than dropping the caller.
 */
export async function tryGetDb(): Promise<Db | null> {
  if (!mongoEnabled()) return null;

  try {
    return await getDb();
  } catch (err) {
    console.error(
      "[mongo] connection failed, falling back to file store:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Close the pool on shutdown. Safe to call when nothing was ever opened. */
export async function closeMongo(): Promise<void> {
  if (cached.client) {
    await cached.client.close();
    cached.client = null;
    cached.promise = null;
  }
}
