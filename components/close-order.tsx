"use client";

import { useState } from "react";
import { useActionState } from "react";
import { CircleSlash, RotateCcw } from "lucide-react";
import type { ActionResult } from "@/lib/actions";

/**
 * The rest is not coming.
 *
 * Not the same statement as "the goods arrived", and kept apart from it on
 * purpose. Linking a receipt says these goods answered this order, and the
 * received quantity goes up. Closing says whatever is still outstanding will
 * never arrive, and the received quantity stays exactly where it is.
 *
 * Using this one where the other was meant silences the overdue warning and
 * leaves the order's received quantity wrong — a report that looks tidy and
 * is false. Hence the reason field, which is required: an order abandoned
 * without a stated reason is one somebody re-opens the question of later.
 */
export function CloseOrder({
  action, documentId, isClosed, outstanding,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  documentId: string;
  isClosed: boolean;
  outstanding: number;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );
  const [open, setOpen] = useState(false);

  if (!isClosed && outstanding <= 0.0001) return null;

  if (!open) {
    return (
      <div className="docactions">
        <button type="button" className="btn ghost" onClick={() => setOpen(true)}>
          {isClosed
            ? <><RotateCcw size={14} aria-hidden="true" /> Expect the rest again</>
            : <><CircleSlash size={14} aria-hidden="true" /> Close the remainder</>}
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="card" style={{ marginBottom: "1rem" }}>
      <input type="hidden" name="document_id" value={documentId} />
      {isClosed && <input type="hidden" name="reopen" value="1" />}

      <div className="card-head">
        <h2>{isClosed ? "Expect the rest after all" : "Close the remainder"}</h2>
        <span className="page-sub">
          {isClosed
            ? "The outstanding quantity goes back to being owed."
            : "Says the outstanding goods are not coming. It does not say they "
              + "arrived — if they did, link the receipt instead, or the order "
              + "will read as never received."}
        </span>
      </div>

      {state && "error" in state && <div className="alert">{state.error}</div>}

      <div className="card-body">
        <div className="field">
          <label htmlFor="close_reason">Why</label>
          <input id="close_reason" name="reason" type="text" required
                 placeholder={isClosed
                   ? "e.g. supplier confirmed the balance will ship"
                   : "e.g. supplier discontinued the line"} />
        </div>
      </div>

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : isClosed ? "Expect the rest" : `Close ${outstanding} outstanding`}
        </button>
        <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
