/**
 * Evaluation runs, persisted so results can be compared over time.
 *
 * Follows the same Mongo-with-file-fallback shape as lib/store/calls.ts: the
 * database matters once deployed because a container's filesystem is
 * ephemeral, and a run that cost real money to produce is exactly the kind of
 * record that must not vanish on redeploy.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tryGetDb } from "../db/mongo";
import type { EvalRun } from "../eval/types";

const COLLECTION = "eval_runs";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "eval-runs.json");

/** Cap the history so a long-lived install does not grow without bound. */
const MAX_RUNS = 200;

async function readFromFile(): Promise<EvalRun[]> {
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Missing file simply means nothing has been run yet.
    return [];
  }
}

export async function listRuns(limit = 50): Promise<EvalRun[]> {
  const db = await tryGetDb();

  if (db) {
    try {
      return await db
        .collection<EvalRun>(COLLECTION)
        .find({}, { projection: { _id: 0 } })
        .sort({ startedAt: -1 })
        .limit(limit)
        .toArray();
    } catch (err) {
      console.error("[evals] mongo read failed:", err);
    }
  }

  const stored = await readFromFile();
  return stored.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

export async function getRun(id: string): Promise<EvalRun | null> {
  const db = await tryGetDb();

  if (db) {
    try {
      return await db
        .collection<EvalRun>(COLLECTION)
        .findOne({ id }, { projection: { _id: 0 } });
    } catch (err) {
      console.error("[evals] mongo read failed:", err);
    }
  }

  return (await readFromFile()).find((r) => r.id === id) ?? null;
}

/** Persist a finished run. Returns false when the write was not durable. */
export async function saveRun(run: EvalRun): Promise<boolean> {
  const db = await tryGetDb();

  if (db) {
    try {
      await db
        .collection<EvalRun>(COLLECTION)
        .replaceOne({ id: run.id }, run, { upsert: true });
      return true;
    } catch (err) {
      console.error("[evals] mongo write failed:", err);
      return false;
    }
  }

  try {
    const stored = await readFromFile();
    const next = [run, ...stored.filter((r) => r.id !== run.id)].slice(0, MAX_RUNS);

    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(next, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("[evals] file write failed:", err);
    return false;
  }
}

export async function deleteRun(id: string): Promise<void> {
  const db = await tryGetDb();

  if (db) {
    try {
      await db.collection<EvalRun>(COLLECTION).deleteOne({ id });
      return;
    } catch (err) {
      console.error("[evals] mongo delete failed:", err);
    }
  }

  try {
    const stored = await readFromFile();
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(
      DATA_FILE,
      JSON.stringify(stored.filter((r) => r.id !== id), null, 2),
      "utf8",
    );
  } catch (err) {
    console.error("[evals] file delete failed:", err);
  }
}
