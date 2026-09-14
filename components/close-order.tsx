"use client";

import { useEffect, useRef, useState } from "react";
import { useActionState } from "react";
import Link from "next/link";
import { CircleSlash, RotateCcw, XCircle, X, AlertCircle } from "lucide-react";
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
 * invoice and refunds no payment — those stay exactly where they are and have
 * to be dealt with on their own terms. That is why the bills, receipts and
 * payments already standing against this order are listed before the reason
 * box rather than discovered afterwards.
 *
 * Not the same statement as "the goods arrived", and still kept apart from
 * it. Linking a receipt says these goods answered this order, and the
 * received quantity goes up. Closing says whatever is outstanding never will
 * arrive, and the received quantity stays exactly where it is.
 *
 * In a drawer rather than inline. This grew from a reason box into figures, a
 * consequence, a document list and a reason, and unfolding all that in the
 * middle of the page pushed the order itself out of sight — the very thing
 * being reviewed. Against the right edge it sits beside the order, which is
 * what reviewing before confirming needs. <dialog> does the rest: focus trap,
 * Esc, inert background.
 *
 * Red on the trigger as well as the confirmation, because they are the same
 * act. A quiet button that opens a red one asks the reader to discover the
 * weight of the thing halfway through doing it.
 */
export function CloseOrder({
  action, documentId, docNo, orderKind, isClosed,
  ordered, fulfilled, outstanding, reopensTo, documents, unitWord,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  documentId: string;
  docNo: string;
  orderKind: "purchase" | "sales";
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
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Once it has posted, the drawer goes: the page behind it has already been
  // revalidated, so leaving it open would show figures that are no longer true
  // beside a button offering to act on them again.
  useEffect(() => {
    if (state && "ok" in state && state.ok) setOpen(false);
  }, [state]);

  if (!isClosed && outstanding <= 0.0001) return null;

  // Nothing received or delivered yet, so there is no part of this order to
  // keep: the whole commitment goes. Anything already fulfilled and only the
  // remainder can be given up.
  const cancelling = !isClosed && fulfilled <= 0.0001;
  const unit = unitWord ? ` ${unitWord}` : "";
  // What is at stake. For a closed order that is what reopening restores: its
  // outstanding reads 0 by definition while it stays closed, so showing that
  // figure would offer to reopen an order for nothing.
  const atStake = isClosed ? reopensTo : outstanding;
  const noun = orderKind === "sales" ? "sales order" : "purchase order";
  const movedWord = orderKind === "sales" ? "Delivered" : "Received";

  const verb = isClosed ? "Reopen" : cancelling ? "Cancel order" : "Close remaining";
  const Icon = isClosed ? RotateCcw : cancelling ? XCircle : CircleSlash;
  const title = isClosed ? `Reopen ${noun}`
    : cancelling ? `Cancel ${noun}`
      : "Close the remainder";

  return (
    <>
      <button
        type="button"
        className={`btn ghost${isClosed ? "" : " danger"}`}
        onClick={() => setOpen(true)}
      >
        <Icon size={14} aria-hidden="true" /> {verb}
      </button>

      <dialog
        ref={ref}
        className="drawer"
        onCancel={(e) => { e.preventDefault(); setOpen(false); }}
        onClick={(e) => { if (e.target === ref.current) setOpen(false); }}
      >
        <form action={formAction} className="drawer-panel">
          <input type="hidden" name="document_id" value={documentId} />
          {isClosed && <input type="hidden" name="reopen" value="1" />}
          {/* The figures this drawer is promising, sent back with the
              decision. They were read when the page rendered; the closure
              reads its own fresh, and between the two a receipt can land.
              Without these the confirmation could say "close 60" while the
              record says 20 was given up, and nobody would learn the two
              disagreed. The engine compares them and refuses. */}
          <input type="hidden" name="saw_fulfilled" value={String(fulfilled)} />
          <input type="hidden" name="saw_outstanding" value={String(atStake)} />

          <div className="drawer-head">
            <div>
              <h2>{title}</h2>
              <span className="drawer-doc">{docNo}</span>
            </div>
            <button type="button" className="drawer-x" onClick={() => setOpen(false)}
                    aria-label="Close">
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          <div className="drawer-body">
            <p className="drawer-lead">
              {isClosed
                ? "Put the remaining quantity back to being expected. Check it "
                  + "against what has happened since — quantities and linked "
                  + "documents may have moved while this was closed."
                : cancelling
                  ? "Cancel the remaining commitment. The order stays in history."
                  : "Say the outstanding goods are not coming. What has already "
                    + "arrived stays exactly as it is."}
            </p>

            <h3 className="drawer-section">Review quantities</h3>
            <div className="drawer-figures">
              <div className="drawer-figure">
                <span className="k">Ordered</span>
                <span className="v">{qty(ordered)}{unit}</span>
              </div>
              <div className="drawer-figure">
                <span className="k">{movedWord}</span>
                <span className="v">{qty(fulfilled)}{unit}</span>
              </div>
              <div className="drawer-figure">
                <span className="k">
                  {isClosed ? "To reopen" : cancelling ? "To cancel" : "To close"}
                </span>
                <span className="v">{qty(atStake)}{unit}</span>
              </div>
            </div>

            <div className="drawer-after">
              <AlertCircle size={15} aria-hidden="true" />
              <span>
                {isClosed
                  ? `After reopening: ${qty(atStake)}${unit} outstanding again`
                  : `After ${cancelling ? "cancellation" : "closing"}: 0${unit} outstanding`}
              </span>
            </div>

            <h3 className="drawer-section">Linked documents</h3>
            <div className="drawer-linked">
              {documents.length === 0 ? (
                <p className="drawer-none">No receipts, invoices or payments linked.</p>
              ) : (
                <>
                  <ul>
                    {documents.map((d) => (
                      <li key={d.id}>
                        <Link href={`/documents/${d.id}`}>{d.doc_no}</Link>
                        <span className="muted">
                          {" · "}{typeName(d.doc_type)}{" · "}{shortDate(d.doc_date)}
                        </span>
                        {Number(d.gross_total ?? 0) !== 0 && (
                          <span className="muted"> · {money(d.gross_total)}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="drawer-note">
                    {isClosed
                      ? "Check these still say what you expect before expecting the rest again."
                      : "These stay as they are. Resolve any of them separately — with a "
                        + "return, a credit or a refund."}
                  </p>
                </>
              )}
            </div>

            {state && "error" in state && <div className="alert">{state.error}</div>}

            <div className="field">
              {/* The asterisk comes from the label style for a required
                  field; adding one here printed "Reason * *". */}
              <label htmlFor="close_reason">Reason</label>
              <textarea id="close_reason" name="reason" required rows={3}
                        placeholder={isClosed
                          ? "e.g. supplier confirmed the balance will ship"
                          : cancelling
                            ? "e.g. order entered twice"
                            : "e.g. customer cancelled the remainder"} />
            </div>

            <p className="drawer-note">No stock or money moves.</p>
          </div>

          <div className="drawer-foot">
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              {isClosed ? "Keep closed" : "Keep order"}
            </button>
            <button type="submit" className={`btn${isClosed ? "" : " danger"}`} disabled={pending}>
              {pending ? "Saving…"
                : isClosed ? `Reopen for ${qty(atStake)}${unit}`
                  : cancelling ? "Cancel order"
                    : `Close remaining ${qty(atStake)}${unit}`}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
