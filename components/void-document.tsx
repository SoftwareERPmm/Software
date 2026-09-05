"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Blocker = { reason: string; docNo?: string; docId?: string };

/**
 * The void control on a posted document.
 *
 * Deliberately not a bare Delete button. Voiding posts a reversing entry and
 * cannot be undone by pressing it again, so the dialog says what will happen
 * in the same words the engine will act in — the effects listed here come
 * from the same analysis the engine re-runs before it writes anything.
 *
 * When something is built on top of the document, the button is not offered
 * at all and the blockers are shown instead, each naming the document in the
 * way. "Void PI-000004 first" is an instruction; a greyed-out button is a
 * puzzle.
 */
export function VoidDocument({
  action, documentId, docNo, canVoid, blockers, effects,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  documentId: string;
  docNo: string;
  canVoid: boolean;
  blockers: Blocker[];
  effects: string[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null
  );
  const [open, setOpen] = useState(false);

  if (!canVoid) {
    return (
      <div className="alert" style={{ marginTop: "0.75rem" }}>
        <strong>This document cannot be voided yet.</strong>
        <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
          {blockers.map((b, i) => (
            <li key={i}>
              {b.docId ? (
                <>
                  <a href={`/documents/${b.docId}`} style={{ color: "var(--brand)" }}>{b.docNo}</a>
                  {b.reason.replace(b.docNo ?? "", "")}
                </>
              ) : b.reason}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="actions">
        <button type="button" className="warn" onClick={() => setOpen(true)}>Void this document</button>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: "0.75rem" }}>
      <div className="card-head">
        <h2>Void {docNo}?</h2>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setOpen(false)}>Cancel</button>
        </span>
      </div>
      <div className="card-body">
        {state && "error" in state && <div className="alert">{state.error}</div>}

        <ul style={{ margin: "0 0 0.75rem", paddingLeft: "1.1rem", color: "var(--muted)" }}>
          {effects.map((e, i) => <li key={i}>{e}</li>)}
        </ul>

        <form action={formAction} className="form">
          <input type="hidden" name="id" value={documentId} />
          <div className="field">
            <label htmlFor="reason">Why</label>
            <input id="reason" name="reason" type="text" autoFocus
                   placeholder="entered twice, wrong customer…" />
            <span className="hint">
              Kept on the document and in the history log. Worth a few words —
              it is what the log will show months from now.
            </span>
          </div>
          <div className="actions">
            <button type="submit" className="warn" disabled={pending}>
              {pending ? "Voiding…" : `Void ${docNo}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
