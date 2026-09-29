"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Paperclip, Trash2, FileText, Image as ImageIcon } from "lucide-react";
import type { ActionResult } from "@/lib/actions";
import { shortDate } from "@/lib/format";

export type Attachment = {
  id: string;
  filename: string;
  mime: string;
  size_bytes: string | number;
  note: string | null;
  uploaded_at: string;
  uploaded_by_name: string | null;
};

/** KB up to a megabyte, then MB. Nobody reads "2,411,008 bytes". */
function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The paper that arrived from outside, kept beside the document it is about.
 *
 * Not the document itself — an invoice in this system is data, and it is
 * drawn from that data whenever it is printed. This is for the supplier's
 * own bill, the delivery note that came back signed, the photograph of the
 * carton that was damaged: evidence of the transaction that has nowhere else
 * to live and otherwise sits in somebody's inbox.
 *
 * The files are in a private bucket and every read goes through this app, so
 * a link here is the only way to reach one.
 */
export function DocumentAttachments({
  documentId, attachments, upload, remove, storageReady,
}: {
  documentId: string;
  attachments: Attachment[];
  upload: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  remove: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  /** False when R2 is not configured — better to say so than to offer a
   *  button that fails on press. */
  storageReady: boolean;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [picked, setPicked] = useState<File | null>(null);

  const [upResult, uploadAction, uploading] =
    useActionState<ActionResult | null, FormData>(upload as never, null);
  const [delResult, deleteAction, deleting] =
    useActionState<ActionResult | null, FormData>(remove as never, null);

  // revalidatePath refreshes the server data, but this component is already
  // on screen and keeps its own — the same refresh every other form here
  // needs after an action.
  useEffect(() => {
    if (upResult && "ok" in upResult) {
      setPicked(null);
      formRef.current?.reset();
      router.refresh();
    }
  }, [upResult, router]);
  useEffect(() => {
    if (delResult && "ok" in delResult) router.refresh();
  }, [delResult, router]);

  const failed = (upResult && "error" in upResult && upResult.error)
    || (delResult && "error" in delResult && delResult.error);

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <Paperclip size={14} aria-hidden="true" style={{ verticalAlign: "-2px" }} />{" "}
          Attached files
        </h2>
        <span className="page-sub">
          {attachments.length === 0
            ? "The supplier's own bill, a signed delivery note, a photo of the goods"
            : `${attachments.length} file${attachments.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <div className="card-body">
        {failed && <div className="alert">{failed}</div>}

        {attachments.length > 0 && (
          <ul className="attachlist">
            {attachments.map((a) => {
              const isImage = a.mime.startsWith("image/");
              return (
                <li key={a.id} className="attachrow">
                  <span className="attachrow-icon" aria-hidden="true">
                    {isImage ? <ImageIcon size={15} /> : <FileText size={15} />}
                  </span>
                  <span className="attachrow-main">
                    <a href={`/documents/${documentId}/attachment/${a.id}`}
                       target="_blank" rel="noreferrer">
                      {a.filename}
                    </a>
                    <span className="subline">
                      {size(Number(a.size_bytes))}
                      {" · "}{shortDate(a.uploaded_at)}
                      {a.uploaded_by_name ? ` · ${a.uploaded_by_name}` : ""}
                      {a.note ? ` · ${a.note}` : ""}
                    </span>
                  </span>
                  <form action={deleteAction}>
                    <input type="hidden" name="attachment_id" value={a.id} />
                    <button type="submit" className="btn ghost tiny" disabled={deleting}
                            aria-label={`Remove ${a.filename}`}>
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}

        {storageReady ? (
          <form ref={formRef} action={uploadAction} className="attachadd">
            <input type="hidden" name="document_id" value={documentId} />
            <input
              type="file" name="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.heic"
              onChange={(e) => setPicked(e.target.files?.[0] ?? null)}
              aria-label="File to attach"
            />
            <input type="text" name="note" placeholder="What is it? (optional)"
                   aria-label="Note" />
            <button type="submit" className="btn ghost" disabled={!picked || uploading}>
              {uploading ? "Uploading…" : "Attach"}
            </button>
            {picked && !uploading && (
              <span className="subline">{size(picked.size)}</span>
            )}
          </form>
        ) : (
          <p className="hint">
            File storage is not configured on this deployment, so nothing can be
            attached here yet.
          </p>
        )}
      </div>
    </section>
  );
}
