/**
 * Saved configurations. Built-in presets ship in code; user configs persist to
 * .data/configs.json.
 *
 * Note: file persistence works in `next dev` and on a normal Node server, but
 * not on serverless hosts with a read-only filesystem. Swap for a database
 * before deploying to one.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PRESETS, type SavedConfig } from "../../lib/presets";

export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "configs.json");

async function readStored(): Promise<SavedConfig[]> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Missing or unreadable file simply means nothing saved yet.
    return [];
  }
}

async function writeStored(configs: SavedConfig[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(configs, null, 2), "utf8");
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

  const stored = await readStored();
  const entry: SavedConfig = {
    id,
    name,
    config: config as SavedConfig["config"],
    builtin: false,
    updatedAt: Date.now(),
  };

  const next = stored.some((c) => c.id === id)
    ? stored.map((c) => (c.id === id ? entry : c))
    : [...stored, entry];

  await writeStored(next);
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

  const stored = await readStored();
  await writeStored(stored.filter((c) => c.id !== id));
  return Response.json({ ok: true });
}
