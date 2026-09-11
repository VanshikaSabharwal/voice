/**
 * Read the text off a page image.
 *
 * Makes one billed Gemini call, and only when an administrator presses the
 * button — never automatically on upload, so choosing an image is free and
 * extraction is a decision.
 */

import { guarded, requireRole } from "../../../../lib/auth/guard";
import { extractPageText } from "../../../../lib/reading/extract-text";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from "../../../../lib/storage/images";

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
    return Response.json({ error: "No image was uploaded." }, { status: 400 });
  }

  // Same allowlist as storage: an extension we would refuse to store is one
  // we should not spend a model call on either.
  if (!ALLOWED_IMAGE_TYPES[file.type]) {
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

  const instruction = form.get("instruction");

  try {
    const result = await extractPageText({
      bytes: Buffer.from(await file.arrayBuffer()),
      mimeType: file.type,
      instruction: typeof instruction === "string" ? instruction : undefined,
    });

    if (result.empty) {
      return Response.json({
        text: "",
        message:
          "No readable text was found in that image. Type the page text yourself, or try an instruction describing where the text is.",
      });
    }

    return Response.json({ text: result.text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed.";
    console.error("[pages] text extraction failed:", message);

    return Response.json({ error: message }, { status: 502 });
  }
});
