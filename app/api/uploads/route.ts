/**
 * Page and cover image uploads.
 *
 * Validation lives here; where the bytes actually land is lib/storage/images.ts,
 * which uses Vercel Blob when BLOB_READ_WRITE_TOKEN is set and the local
 * public/uploads directory otherwise. Only the returned URL is stored on the
 * page record, so the two backends are interchangeable.
 */

import { guarded, requireRole } from "../../../lib/auth/guard";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  blobEnabled,
  storeImage,
} from "../../../lib/storage/images";

export const dynamic = "force-dynamic";

export const POST = guarded(async (request: Request) => {
  await requireRole("admin");

  let form: FormData;

  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected a multipart form upload." },
      { status: 400 },
    );
  }

  const file = form.get("file");

  if (!(file instanceof File)) {
    return Response.json({ error: "No file was uploaded." }, { status: 400 });
  }

  const extension = ALLOWED_IMAGE_TYPES[file.type];

  if (!extension) {
    return Response.json(
      { error: "Only PNG, JPEG, WebP and GIF images are accepted." },
      { status: 415 },
    );
  }

  if (file.size > MAX_IMAGE_BYTES) {
    return Response.json(
      { error: "Images must be 4MB or smaller." },
      { status: 413 },
    );
  }

  try {
    const { url } = await storeImage(file, extension);
    return Response.json({ url });
  } catch (err) {
    console.error("[uploads] store failed:", err);

    /* Name the actual cause. On the local backend a failed write means a
       read-only or ephemeral filesystem, and the fix is to configure Blob —
       which is not something a generic "upload failed" would ever suggest.
       When Blob is configured, surface the SDK message so a public/private
       store mismatch is actionable instead of a blank 500. */
    const detail =
      err instanceof Error && err.message.trim() ? err.message.trim() : null;

    return Response.json(
      {
        error: blobEnabled()
          ? detail
            ? `Could not store the image in Blob storage: ${detail}`
            : "Could not store the image in Blob storage."
          : "Could not store the image — the server's filesystem is not writable. Set BLOB_READ_WRITE_TOKEN to store images in Vercel Blob.",
      },
      { status: 500 },
    );
  }
});
