/**
 * A generic id-keyed collection over MongoDB, falling back to .data/*.json.
 *
 * The reading platform has six entity types that all need the same
 * find/insert/update/delete over the same dual backend. Writing that fallback
 * out once per entity — as app/api/configs/route.ts does for its single type —
 * would be six copies of the same subtle behaviour, so it lives here instead.
 *
 * Reads are not cached: unlike the call log, these are user-edited records
 * where a teacher must see an admin's change immediately, and the volumes are
 * small enough that a query per request costs nothing.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tryGetDb } from "../db/mongo";

const DATA_DIR = path.join(process.cwd(), ".data");

/** Every stored entity is addressed by a string id. */
type Entity = { id: string };

export class Collection<T extends Entity> {
  private file: string;
  /** Serialises file writes so two requests cannot clobber each other. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private name: string) {
    this.file = path.join(DATA_DIR, `${name}.json`);
  }

  private async readFile(): Promise<T[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Missing file simply means nothing stored yet.
      return [];
    }
  }

  private async writeFileAll(records: T[]): Promise<boolean> {
    let ok = true;

    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(DATA_DIR, { recursive: true });
        await writeFile(this.file, JSON.stringify(records, null, 2), "utf8");
      } catch (err) {
        console.error(`[${this.name}] file write failed:`, err);
        ok = false;
      }
    });

    await this.writeChain;
    return ok;
  }

  /** All records, optionally filtered by an exact-match subset of fields. */
  async list(where: Partial<T> = {}): Promise<T[]> {
    const db = await tryGetDb();

    if (db) {
      try {
        return await db
          .collection<T>(this.name)
          .find(where as never, { projection: { _id: 0 } })
          .toArray() as T[];
      } catch (err) {
        console.error(`[${this.name}] mongo read failed:`, err);
      }
    }

    const entries = Object.entries(where) as [keyof T, unknown][];

    return (await this.readFile()).filter((record) =>
      entries.every(([key, value]) => record[key] === value),
    );
  }

  async get(id: string): Promise<T | null> {
    const [found] = await this.list({ id } as Partial<T>);
    return found ?? null;
  }

  /** Find the first record matching a filter. */
  async find(where: Partial<T>): Promise<T | null> {
    const [found] = await this.list(where);
    return found ?? null;
  }

  /** Insert or replace by id. Returns false if the write was not durable. */
  async put(record: T): Promise<boolean> {
    const db = await tryGetDb();

    if (db) {
      try {
        await db
          .collection<T>(this.name)
          .replaceOne({ id: record.id } as never, record as never, { upsert: true });
        return true;
      } catch (err) {
        console.error(`[${this.name}] mongo write failed:`, err);
        return false;
      }
    }

    const records = await this.readFile();
    const index = records.findIndex((r) => r.id === record.id);

    if (index === -1) records.push(record);
    else records[index] = record;

    return this.writeFileAll(records);
  }

  /** Merge fields into an existing record. Returns the updated record. */
  async patch(id: string, changes: Partial<T>): Promise<T | null> {
    const existing = await this.get(id);

    if (!existing) return null;

    // `id` is the key; letting a patch move a record to a different id would
    // silently orphan everything referencing it.
    const updated = { ...existing, ...changes, id: existing.id };

    return (await this.put(updated)) ? updated : null;
  }

  async remove(id: string): Promise<boolean> {
    const db = await tryGetDb();

    if (db) {
      try {
        await db.collection<T>(this.name).deleteOne({ id } as never);
        return true;
      } catch (err) {
        console.error(`[${this.name}] mongo delete failed:`, err);
        return false;
      }
    }

    const records = await this.readFile();
    return this.writeFileAll(records.filter((r) => r.id !== id));
  }

  /** Delete every record matching a filter. Returns how many went. */
  async removeWhere(where: Partial<T>): Promise<number> {
    const doomed = await this.list(where);

    for (const record of doomed) await this.remove(record.id);

    return doomed.length;
  }
}
