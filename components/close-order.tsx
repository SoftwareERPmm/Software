"use client";

import { useState } from "react";
import { useActionState } from "react";
import Link from "next/link";
import { CircleSlash, RotateCcw, XCircle } from "lucide-react";
import type { ActionResult } from "@/lib/actions";

type Linked = {
  id: string; doc_type: string; doc_no: string;
  doc_date: Date | string; gross_total: unknown;
};

const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const money = (n: unknown) => Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
const shortDate = (d: Date | string) =>
  (typeof d === "string" ? d : d.toISOString()).slice(0, 10);
const typeName = (t: string) =>
  t.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * The rest is not coming.
 *
 * Two different statements wear the same mechanism. Nothing received yet and
 * the whole order is being abandoned: that is a cancellation. Forty of a
 * hundred received and the remaining sixty called off: that is closing the
 * remainder, and the forty still happened. The database records one closure
 * row either way; what changes is which of the two a person is being asked to
 * confirm, and what the confirmation promises.
 *
 * Neither one touches anything else. Closing moves no stock, cancels no
 * invoice and refunds no payment — those stay exactly where they are, and
 * have to be dealt with on their own terms. That is precisely why the bills,
 * receipts and payments already standing against this order are listed before
 * the reason box rather than after the fact: the person clicking needs to see
 * what this does not resolve.
 *
 * Not the same statement as "the goods arrived", and still kept apart from
 * it. Linking a receipt says these goods answered this order, and the
 * received quantity goes up. Closing says whatever is outstanding never will
 * arrive, and the received quantity stays exactly where it is. Using this one
 * where the other was meant silences the overdue warning and leaves the
 * order's received quantity wrong — a report that looks tidy and is false.
 */
export function CloseOrder({
  action, documentId, isClosed, ordered, fulfilled, outstanding, reopensTo,
  documents, unitWord,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  documentId: string;
  isClosed: boolean;
  ordered: number;
  fulfilled: number;
  outstanding: number;
  /** What would be owed again — a closed order reports 0 outstanding. */
  reopensTo: number;
  documents: Linked[];
  unitWord?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );
  const [open, setOpen] = useState(false);

  if (!isClosed && outstanding <= 0.0001) return null;

  // Nothing received or delivered yet, so there is no part of this order to
  // keep: the whole commitment goes. Anything already fulfilled and only the
  // remainder can be given up.
  const cancelling = !isClosed && fulfilled <= 0.0001;
  const unit = unitWord ? ` ${unitWord}` : "";
  // What is at stake. For a closed order that is what reopening restores:
  // its outstanding reads 0 by definition while it stays closed, so showing
  // that figure would offer to reopen an order for nothing.
  const atStake = isClosed ? reopensTo : outstanding;

  const verb = isClosed ? "Reopen" : cancelling ? "Cancel order" : "Close remaining";
  const Icon = isClosed ? RotateCcw : cancelling ? XCircle : CircleSlash;

  if (!open) {
    return (
      <div className="docactions">
        <button type="button" className="btn ghost" onClick={() => setOpen(true)}>
          <Icon size={14} aria-hidden="true" /> {verb}
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="card" style={{ marginBottom: "1rem" }}>
      <input type="hidden" name="document_id" value={documentId} />
      {isClosed && <input type="hidden" name="reopen" value="1" />}

      {/* The figures this panel is promising, sent back with the decision.
          They were read when the page rendered; the closure reads its own
          fresh, and between the two a receipt can land. Without these the
          confirmation could say "close 60" while the record says 20 was given
          up, and nobody would learn the two disagreed. The engine compares
          them and refuses rather than quietly recording something else. */}
      <input type="hidden" name="saw_fulfilled" value={String(fulfilled)} />
      <input type="hidden" name="saw_outstanding" value={String(atStake)} />

      <div className="card-head">
        <h2>{verb}</h2>
        <span className="page-sub">
          {isClosed
            ? "The outstanding quantity goes back to being owed. Check it against "
              + "what has happened since — quantities and linked documents may have "
              + "moved while this was closed."
            : cancelling
              ? "Nothing has been received or delivered against this order, so the "
                + "whole commitment is given up. The order itself is kept."
              : "Says the outstanding goods are not coming. It does not say they "
                + "arrived — if they did, link the receipt instead, or the order "
                + "will read as never received."}
        </span>
      </div>

      {state && "error" in state && <div className="alert">{state.error}</div>}

      <div className="card-body">
        {/* The figures being confirmed, and what they become. Shown as one
            line each rather than a table: there are three numbers and a
            person is deciding on them, not studying them. */}
        <div className="closure-preview">
          <div className="closure-now">
            <strong>{qty(ordered)}{unit} ordered</strong>
            <span> · {qty(fulfilled)} fulfilled</span>
            <span> · {qty(atStake)} remaining</span>
          </div>
          <div className="closure-then">
            {isClosed
              ? <>After: <strong>{qty(fulfilled)} fulfilled · {qty(atStake)} outstanding again</strong></>
              : cancelling
                ? <>After: <strong>0 fulfilled · {qty(atStake)} cancelled · 0 outstanding</strong></>
                : <>After: <strong>{qty(fulfilled)} fulfilled · {qty(atStake)} closed · 0 outstanding</strong></>}
          </div>
        </div>

        {documents.length > 0 && (
          <div className="closure-linked">
            <div className="closure-linked-head">
              {isClosed ? "Standing against this order now" : "This does not touch"}
            </div>
            <ul>
              {documents.map((d) => (
                <li key={d.id}>
                  <Link href={`/documents/${d.id}`}>{d.doc_no}</Link>
                  <span className="muted"> · {typeName(d.doc_type)} · {shortDate(d.doc_date)}</span>
                  {Number(d.gross_total ?? 0) !== 0 && (
                    <span className="muted"> · {money(d.gross_total)}</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="closure-linked-note">
              {isClosed
                ? "Check these still say what you expect before expecting the rest again."
                : "Stock stays where it is, bills stay owed and payments stay made. "
                  + "Resolve any of these separately — with a return, a credit or a refund."}
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor="close_reason">Reason</label>
          <input id="close_reason" name="reason" type="text" required
                 placeholder={isClosed
                   ? "e.g. supplier confirmed the balance will ship"
                   : cancelling
                     ? "e.g. entered twice"
                     : "e.g. customer cancelled the remainder"} />
        </div>
      </div>

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…"
            : isClosed ? `Reopen for ${qty(atStake)}${unit}`
              : cancelling ? `Cancel all ${qty(atStake)}${unit}`
                : `Close remaining ${qty(atStake)}${unit}`}
        </button>
        <button type="button" className="ghost" onClick={() => setOpen(false)}>Back</button>
      </div>
    </form>
  );
}
