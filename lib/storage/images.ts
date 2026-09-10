/**
 * Where page and cover images are stored.
 *
 * Two backends behind one function, chosen by whether a Blob token is present:
 *
 *   Vercel Blob — durable, and the only option that actually works deployed.
 *     Vercel's filesystem is read-only and Render's is ephemeral, so a local
 *     write either fails outright or is silently discarded on redeploy.
 *
 *   Local disk (public/uploads) — the fallback, so `npm run dev` needs no
 *     cloud account, matching how MONGODB_URL is optional elsewhere here.
 *
 * Callers only ever see the returned URL, which is what gets stored on the
 * page record. That is why swapping backends needs no change anywhere else:
 * an <img src> does not care which host served it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Extensions by content type. An allowlist, not the client's filename. */
export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Upload ceiling, 4 MB.
 *
 * Vercel caps a function's request body at 4.5 MB, and that limit is enforced
 * by the platform BEFORE the handler runs — a larger upload fails as an opaque
 * 413 that no code here can turn into a useful message. Staying under it means
 * the rejection comes from us, with an explanation. Client-side uploads are
 * the documented way past this if page scans ever need to be bigger.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function blobEnabled(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

export type StoredImage = { url: string };

/**
 * Store one image and return the URL to embed.
 *
 * Throws on failure so the route can report why; callers should not have to
 * distinguish a missing token from a full disk.
 */
export async function storeImage(
  file: File,
  extension: string,
): Promise<StoredImage> {
  // Generated name, never the client's: an uploaded filename can contain path
  // separators and escape the directory it is meant to land in.
  const name = `${randomUUID()}.${extension}`;

  if (blobEnabled()) {
    // Imported lazily so the package is not required at all when running on
    // the local-disk fallback.
    const { put } = await import("@vercel/blob");

    const blob = await put(`reading/${name}`, file, {
      // Public: these URLs go straight into an <img src> on the student and
      // admin pages, so they must be fetchable without a signed request.
      access: "public",
      // The UUID already makes the name unique; a second suffix would only
      // make the stored path harder to match against what we generated.
      addRandomSuffix: false,
      contentType: file.type,
    });

    return { url: blob.url };
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(
    path.join(UPLOAD_DIR, name),
    Buffer.from(await file.arrayBuffer()),
  );

  return { url: `/uploads/${name}` };
}
