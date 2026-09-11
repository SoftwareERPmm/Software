import Link from "next/link";
import { Route, ArrowRight } from "lucide-react";
import { qty } from "@/lib/format";
import type { TransactionOrigin } from "@/lib/queries";

const PAYMENT_WORD = {
  PAID: "Paid in full",
  PARTIAL: "Partly paid",
  UNPAID: "Unpaid",
} as const;

/**
 * Which route this transaction took, and where correcting it belongs.
 *
 * An invoice raised without an order is not an unfinished one. A walk-in sale
 * and a phoned-in purchase are ordinary, complete business — but a chain drawn
 * as a row of stages makes the stage nobody used look like the stage nobody
 * got to, and that is the reading this card exists to stop. So it says which
 * route was actually taken, and distinguishes three things a blank space
 * cannot:
 *
 *   Not used       an optional stage this transaction skipped
 *   Pending        a stage it needs and has not reached
 *   Not required   a stage that does not apply, as for a service
 *
 * And it says where a correction goes, because that is the question a reader
 * has next and the answer is not always "here": an invoice raised through an
 * order is corrected at the order, which is why this document has no edit
 * button of its own.
 */
export function TransactionOrigin({
  origin, docNo,
}: { origin: TransactionOrigin; docNo: string }) {
  const { order, fulfilment, payment, correctAt, sales } = origin;
  const fulfilmentDocs = [...origin.fulfilmentBefore, ...origin.fulfilmentAfter];

  /**
   * The route, in the order it happened. Which way round depends on where it
   * began: goods that answered an invoice come after it, goods that were
   * billed by one came before, and drawing both the same way would make a
   * deliver-later invoice look like it was raised from its own delivery.
   */
  const path: { id: string | null; doc_no: string }[] = [
    ...(origin.startedFrom === "ORDER" && origin.startDoc ? [origin.startDoc] : []),
    ...origin.fulfilmentBefore,
    { id: null, doc_no: docNo },
    ...origin.fulfilmentAfter,
  ];

  const startedFrom =
    origin.startedFrom === "ORDER"
      ? `${sales ? "Sales order" : "Purchase order"} ${origin.startDoc?.doc_no ?? ""}`
      : origin.startedFrom === "FULFILMENT"
        ? `${sales ? "Delivery" : "Goods receipt"} ${origin.startDoc?.doc_no ?? ""}`
        : `Direct ${sales ? "sales" : "purchase"} invoice`;

  const moveWord = sales ? "Delivery" : "Goods receipt";

  return (
    <section className="origin">
      <div className="origin-head">
        <Route size={14} aria-hidden="true" />
        <strong>Started from {startedFrom}</strong>
      </div>

      <dl className="origin-list">
        <dt>Order</dt>
        <dd>
          {order.state === "NOT_USED" ? (
            <span className="origin-skip">
              Not used
              <span className="origin-why">
                {" "}— this {sales ? "sale" : "purchase"} did not go through one
              </span>
            </span>
          ) : order.state === "USED" ? (
            <Link href={`/documents/${order.doc.id}`}>{order.doc.doc_no}</Link>
          ) : (
            <>
              {/* All of them. Goods from one receipt can answer two orders,
                  and naming one reads as the whole answer. */}
              {order.docs.map((o, i) => (
                <span key={o.id}>
                  {i > 0 && " · "}
                  <Link href={`/documents/${o.id}`}>{o.doc_no}</Link>
                </span>
              ))}
              <span className="origin-why">
                {" "}· linked {order.docs.length === 1 ? "later" : "later"}, not where this began
              </span>
            </>
          )}
        </dd>

        <dt>{moveWord}</dt>
        <dd>
          {fulfilment.state === "NOT_REQUIRED" ? (
            <span className="origin-skip">
              Not required
              <span className="origin-why"> — nothing physical to {sales ? "deliver" : "receive"}</span>
            </span>
          ) : fulfilment.state === "PENDING" ? (
            <span className="origin-wait">
              Pending
              <span className="origin-why">
                {" "}— the goods have not {sales ? "gone out" : "arrived"} yet
              </span>
            </span>
          ) : (
            <>
              {fulfilmentDocs.map((d, i) => (
                <span key={d.id}>
                  {i > 0 && " · "}
                  <Link href={`/documents/${d.id}`}>{d.doc_no}</Link>
                </span>
              ))}
              {fulfilment.state === "DONE" ? (
                <span className="origin-why">
                  {" "}· fully {sales ? "delivered" : "received"}
                </span>
              ) : (
                <span className="origin-wait">
                  {" "}· {qty(String(fulfilment.outstanding))}
                  {fulfilment.unit ? ` ${fulfilment.unit}` : ""} still to come
                </span>
              )}
            </>
          )}
        </dd>

        <dt>Payment</dt>
        <dd>{PAYMENT_WORD[payment]}</dd>

        <dt>Correct at</dt>
        <dd>
          {correctAt.kind === "ORDER" ? (
            <>
              <Link href={`/documents/${correctAt.doc.id}`}>{correctAt.doc.doc_no}</Link>
              <span className="origin-why">
                {" "}— the price was agreed there, so it is corrected there
              </span>
            </>
          ) : (
            <>
              This invoice
              <span className="origin-why"> — nothing upstream priced it</span>
            </>
          )}
        </dd>
      </dl>

      {/* The route as one line, where there is more than one step to it. */}
      {path.length > 1 && (
        <div className="origin-path">
          {path.map((d, i) => (
            <span key={d.id ?? "self"}>
              {i > 0 && <ArrowRight size={11} aria-hidden="true" />}
              {d.id
                ? <Link href={`/documents/${d.id}`}>{d.doc_no}</Link>
                : <strong>{d.doc_no}</strong>}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
