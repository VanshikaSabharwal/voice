/**
 * Loads .env.local into process.env for the standalone voice server.
 *
 * `next dev` does this automatically, but the voice server runs as its own
 * Node process under tsx and gets no such help — without this it starts up
 * fine and then fails on the first provider call with "No API key configured",
 * which is a confusing way to learn that the environment simply was not read.
 *
 * Import this before anything that calls keyFor().
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/** Files to read, later ones losing to earlier ones (Next's precedence). */
const FILES = [".env.local", ".env"];

function parse(contents: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const raw of contents.split("\n")) {
    const line = raw.trim();

    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip matching surrounding quotes, if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) out[key] = value;
  }

  return out;
}

let loaded = false;

export function loadEnv(cwd: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;

  for (const file of FILES) {
    let contents: string;

    try {
      contents = readFileSync(path.join(cwd, file), "utf8");
    } catch {
      // A missing env file is normal; keys may come from the real environment.
      continue;
    }

    for (const [key, value] of Object.entries(parse(contents))) {
      // Never override a value the process was actually started with.
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
