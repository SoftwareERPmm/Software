"use client";

import { useRef, useState } from "react";
import { ImagePlus, UploadCloud, X } from "lucide-react";

/**
 * Giving an item a picture, or not.
 *
 * Optional throughout, and it has to look optional: a company with eight
 * hundred items is not going to photograph them, and this sits in the form as
 * one more empty field rather than as a step. Nothing here is required and
 * nothing warns when it is left alone.
 *
 * The file dialog is asked for images and nothing else, so a spreadsheet is
 * not offered in the first place. That is a courtesy rather than a guarantee
 * — `accept` is advice a file dialog is free to ignore, and a drag-and-drop
 * bypasses it entirely — which is why the bytes are decoded here and decoded
 * again on the server, and why what gets stored is always something the
 * server itself encoded.
 *
 * The picture is shrunk before it is sent. A photo off a phone is several
 * megabytes, a server action's body is not, and there is no reason to move
 * 6MB to store 40KB of it.
 */

/** Long edge, before it goes. The server re-encodes to the same bound. */
const MAX_PX = 512;

const ACCEPT = "image/png,image/jpeg,image/webp";

async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_PX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot resize the image");
  // Whatever was transparent becomes white here too, so what the form shows
  // is what the server will store rather than a preview that differs from it.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return canvas.toDataURL("image/webp", 0.85);
}

export function ItemPhotoField({
  /** The photo already on the item, if it has one. */
  currentSrc,
  label = "Photo",
}: {
  currentSrc?: string | null;
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(currentSrc ?? null);
  const [picked, setPicked] = useState<string>("");
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function take(file: File | undefined) {
    if (!file) return;
    setError(null);

    if (!file.type.startsWith("image/")) {
      setError("That is not an image. Choose a PNG, JPEG or WebP.");
      return;
    }

    setBusy(true);
    try {
      const dataUrl = await shrink(file);
      setPicked(dataUrl);
      setPreview(dataUrl);
      setRemoved(false);
    } catch {
      setError("That image could not be read. Try a PNG, JPEG or WebP.");
    } finally {
      setBusy(false);
      // Cleared so choosing the same file twice in a row still fires change.
      if (input.current) input.current.value = "";
    }
  }

  function clear() {
    setPicked("");
    setPreview(null);
    setError(null);
    // Only meaningful where there was a stored photo to remove. Dropping a
    // pick that was never saved is just a cleared field.
    setRemoved(Boolean(currentSrc));
    if (input.current) input.current.value = "";
  }

  return (
    <div className="field">
      <label htmlFor="item_photo">{label}</label>

      <input type="hidden" name="photo_data" value={picked} />
      <input type="hidden" name="photo_remove" value={removed ? "1" : ""} />

      <div className="photofield">
        <span className="photofield-preview" aria-hidden={!preview}>
          {preview
            ? <img src={preview} alt="" />
            : <ImagePlus size={18} aria-hidden="true" />}
        </span>

        <div className="photofield-controls">
          <button
            type="button"
            className="ghost tiny"
            onClick={() => input.current?.click()}
            disabled={busy}
          >
            <UploadCloud size={14} aria-hidden="true" />
            {busy ? "Reading…" : preview ? "Change photo" : "Upload photo"}
          </button>

          {preview && (
            <button type="button" className="ghost tiny" onClick={clear} disabled={busy}>
              <X size={13} aria-hidden="true" /> Remove
            </button>
          )}

          <span className="hint">Optional · PNG, JPEG or WebP</span>
        </div>
      </div>

      {error && <span className="hint" style={{ color: "var(--bad)" }}>{error}</span>}

      <input
        ref={input}
        id="item_photo"
        type="file"
        className="visually-hidden"
        tabIndex={-1}
        accept={ACCEPT}
        onChange={(e) => take(e.target.files?.[0])}
      />
    </div>
  );
}
