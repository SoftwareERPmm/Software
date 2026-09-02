"use client";

import { useRef, useState } from "react";
import { UploadCloud, FileSpreadsheet, X } from "lucide-react";

export type Upload = { content: string; format: "csv" | "xlsx"; name: string };

/**
 * Picking a spreadsheet.
 *
 * A bare <input type="file"> renders as a small grey button whose label the
 * browser chooses and the page cannot style, which reads as an afterthought
 * on a screen whose whole purpose is that one file. This is the same input,
 * kept for the file dialog and for keyboard and screen-reader users, hidden
 * behind a drop zone that says what it wants.
 *
 * A workbook is encoded to base64 and a CSV read as text, because the two are
 * read by different code on the server — and reading the workbook rather than
 * a CSV of it is what keeps a long barcode intact.
 */
export function FileDrop({
  onPick, onClear, busy, accept = ".xlsx,.csv", picked,
}: {
  onPick: (u: Upload) => void;
  onClear?: () => void;
  busy?: boolean;
  accept?: string;
  picked?: string | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  async function encode(file: File): Promise<Upload> {
    const isCsv = /\.csv$/i.test(file.name) || file.type === "text/csv";
    if (isCsv) return { content: await file.text(), format: "csv", name: file.name };

    // Chunked: spreading a whole file into String.fromCharCode in one call
    // overflows the argument list on anything but a tiny sheet.
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { content: btoa(binary), format: "xlsx", name: file.name };
  }

  const take = (file: File | undefined) => { if (file) encode(file).then(onPick); };

  if (picked) {
    return (
      <div className="row" style={{ alignItems: "center", gap: "0.6rem" }}>
        <FileSpreadsheet size={18} style={{ color: "var(--brand)", flexShrink: 0 }} />
        <span style={{ fontWeight: 500 }}>{picked}</span>
        {onClear && (
          <button type="button" className="ghost tiny" onClick={() => {
            if (input.current) input.current.value = "";
            onClear();
          }}>
            <X size={13} /> Choose another
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]); }}
        disabled={busy}
        style={{
          width: "100%", padding: "1.6rem 1rem", cursor: busy ? "wait" : "pointer",
          display: "flex", flexDirection: "column", alignItems: "center", gap: "0.5rem",
          border: `1.5px dashed ${over ? "var(--brand)" : "var(--line)"}`,
          borderRadius: "var(--radius, 8px)",
          background: over ? "var(--line-soft)" : "transparent",
          color: "inherit", font: "inherit", textAlign: "center",
        }}
      >
        <UploadCloud size={30} style={{ color: over ? "var(--brand)" : "var(--muted)" }} />
        <span style={{ fontWeight: 600 }}>
          {busy ? "Reading the file…" : "Choose a file, or drag one here"}
        </span>
        <span className="hint">Excel .xlsx or .csv</span>
      </button>
      <input
        ref={input} type="file" className="visually-hidden" tabIndex={-1} aria-hidden="true"
        accept={accept}
        onChange={(e) => take(e.target.files?.[0])}
      />
    </>
  );
}
