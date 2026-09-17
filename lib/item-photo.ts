import sharp from "sharp";

/**
 * Turning whatever somebody picked into something we are willing to store.
 *
 * Nothing that arrives is trusted and nothing that arrives is kept. The file
 * a browser hands over is a claim about its own type — a .png extension and
 * an image/png header cost nothing to fake — so the bytes are decoded and
 * re-encoded rather than inspected and filed. What lands in the column is
 * always a WebP this function produced, which is what makes serving it back
 * with a content type safe.
 *
 * The client already shrinks the picture before sending it; this is not a
 * second opinion about the size but the only one that counts. A resize done
 * in the page is a convenience — it keeps a 6MB photo from a phone out of a
 * request — and a convenience is not a constraint.
 */

/** Long edge. Enough for a detail view, small enough that a row is cheap. */
export const PHOTO_MAX_PX = 512;

export const PHOTO_MIME = "image/webp";

/** Before decoding. A refusal here is cheaper than a refusal inside sharp. */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

export type EncodedPhoto = { bytes: Buffer; mime: string };

/**
 * @param input a data URL or bare base64 — what the picker in the page sends.
 * @throws when it is not an image, or is one we cannot read.
 */
export async function encodeItemPhoto(input: string): Promise<EncodedPhoto> {
  const base64 = input.startsWith("data:")
    ? input.slice(input.indexOf(",") + 1)
    : input;

  if (!base64.trim()) throw new Error("No image was sent");

  const raw = Buffer.from(base64, "base64");
  if (raw.length === 0) throw new Error("That file could not be read as an image");
  if (raw.length > MAX_INPUT_BYTES) {
    throw new Error("That image is too large — please choose one under 8MB");
  }

  let out: Buffer;
  try {
    out = await sharp(raw)
      // Never enlarges: a 60px logo stays 60px rather than being blown up to
      // 512 and stored eight times over as blur.
      .resize({ width: PHOTO_MAX_PX, height: PHOTO_MAX_PX, fit: "inside", withoutEnlargement: true })
      // Transparency becomes white rather than travelling with the file. A
      // cut-out PNG is the common case for a product shot, and one kept
      // transparent is invisible against a dark row and a surprise on paper.
      .flatten({ background: "#ffffff" })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    // sharp refuses anything it cannot decode, which is the check: a PDF, a
    // spreadsheet or a renamed zip never gets past here.
    throw new Error("That file is not an image we can read — try a PNG, JPEG or WebP");
  }

  return { bytes: out, mime: PHOTO_MIME };
}
