/**
 * Saved configurations. Built-in presets ship in code; user configs persist to
 * MongoDB when MONGODB_URL is set, and to .data/configs.json otherwise.
 *
 * The database is what makes saving work once deployed: Vercel's filesystem is
 * read-only and Render's is ephemeral, so a file write either fails outright or
 * is discarded on the next deploy. The file path remains for local development,
 * so `npm run dev` needs no database running.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PRESETS, type SavedConfig } from "../../lib/presets";
import { COLLECTIONS, tryGetDb } from "../../../lib/db/mongo";

export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "configs.json");

async function readFromFile(): Promise<SavedConfig[]> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Missing or unreadable file simply means nothing saved yet.
    return [];
  }
}

async function readStored(): Promise<SavedConfig[]> {
  const db = await tryGetDb();

  if (db) {
    // `_id` is Mongo's own key and is not part of SavedConfig; excluding it
    // keeps what the client receives identical to the file-store shape.
    return db
      .collection<SavedConfig>(COLLECTIONS.configs)
      .find({}, { projection: { _id: 0 } })
      .toArray();
  }

  return readFromFile();
}

/**
 * Persist one config. Returns false when the write could not be made durable,
 * so the caller can report a failure instead of silently losing the edit.
 */
async function writeOne(entry: SavedConfig): Promise<boolean> {
  const db = await tryGetDb();

  if (db) {
    try {
      await db
        .collection<SavedConfig>(COLLECTIONS.configs)
        .replaceOne({ id: entry.id }, entry, { upsert: true });
      return true;
    } catch (err) {
      console.error("[configs] mongo write failed:", err);
      return false;
    }
  }

  try {
    const stored = await readFromFile();
    const next = stored.some((c) => c.id === entry.id)
      ? stored.map((c) => (c.id === entry.id ? entry : c))
      : [...stored, entry];

    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(next, null, 2), "utf8");
    return true;
  } catch (err) {
    // A read-only or ephemeral filesystem is the usual cause once deployed,
    // and is exactly what MONGODB_URL is for.
    console.error("[configs] file write failed:", err);
    return false;
  }
}

async function deleteOne(id: string): Promise<boolean> {
  const db = await tryGetDb();

  if (db) {
    try {
      await db.collection<SavedConfig>(COLLECTIONS.configs).deleteOne({ id });
      return true;
    } catch (err) {
      console.error("[configs] mongo delete failed:", err);
      return false;
    }
  }

  try {
    const stored = await readFromFile();
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(
      DATA_FILE,
      JSON.stringify(stored.filter((c) => c.id !== id), null, 2),
      "utf8",
    );
    return true;
  } catch (err) {
    console.error("[configs] file delete failed:", err);
    return false;
  }
}

export async function GET() {
  const stored = await readStored();
  return Response.json({ configs: [...PRESETS, ...stored] });
}

export async function POST(request: Request) {
  let body: { id?: string; name?: string; config?: unknown };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { id, name, config } = body;
  if (!id || !name || !config) {
    return Response.json(
      { error: "id, name and config are required." },
      { status: 400 },
    );
  }

  if (PRESETS.some((p) => p.id === id)) {
    return Response.json(
      { error: "Built-in configurations cannot be overwritten." },
      { status: 409 },
    );
  }

  const entry: SavedConfig = {
    id,
    name,
    config: config as SavedConfig["config"],
    builtin: false,
    updatedAt: Date.now(),
  };

  /* Report a failed write rather than returning 200 over a lost edit: the
     Settings page shows this message, and "saved" on something that was not
     saved is the worst possible outcome — the next call would quietly use the
     old providers. */
  if (!(await writeOne(entry))) {
    return Response.json(
      {
        error:
          "Could not save. The server's filesystem is not writable — set MONGODB_URL to persist configurations.",
      },
      { status: 500 },
    );
  }

  return Response.json({ config: entry });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return Response.json({ error: "id query parameter required." }, { status: 400 });
  }

  if (PRESETS.some((p) => p.id === id)) {
    return Response.json(
      { error: "Built-in configurations cannot be deleted." },
      { status: 409 },
    );
  }

  if (!(await deleteOne(id))) {
    return Response.json(
      { error: "Could not delete. Storage is not writable." },
      { status: 500 },
    );
  }

  return Response.json({ ok: true });
}
