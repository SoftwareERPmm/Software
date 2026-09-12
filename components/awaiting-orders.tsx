import Link from "next/link";
import { AlertCircle, ArrowUpRight } from "lucide-react";
import { qty, shortDate } from "@/lib/format";
import type { AwaitingLine } from "@/lib/queries";

/**
 * What this partner is already waiting for, said before the same thing is
 * recorded twice — on the form that would order it again, and on the one
 * that would bill or ship it outside the order it belongs to.
 *
 * The duplicate order is not a careless mistake. It is made by someone doing
 * everything right on a blank form, who has no way of knowing that an order
 * for the same goods went out nine days ago — the screen never mentions it,
 * so there is nothing to notice. This puts the answer where the question is
 * asked: the moment a partner is chosen, and specific enough to act on, in
 * quantities rather than a count of documents.
 *
 * It does not block, and it does not merge. Two orders to one supplier are
 * ordinary — a second shop, a rush, a split delivery — so the form stays open
 * below and posts exactly what it is told to post. Nothing here writes
 * anything; it is a reminder, not a rule.
 *
 * Only orders nothing has happened to appear. See getUntouchedOpenOrders for
 * why a part-received or already billed order is deliberately left out.
 */
export function AwaitingOrders({
  lines, sales, purpose = "order",
}: {
  lines: AwaitingLine[];
  sales: boolean;
  /**
   * Which form is asking. Both show the same orders; what differs is what
   * the reader is about to do, and so what they should do instead.
   *
   *   order  about to place another order    — may be duplicating the goods
   *   bill   about to bill or ship outside it — may be duplicating the
   *          whole transaction, because the voucher raises its own receipt
   *          or delivery and the order is still owed the goods afterwards
   */
  purpose?: "order" | "bill";
}) {
  if (lines.length === 0) return null;

  // One row per order, its items named on it — because "2 open orders" is the
  // headline and "100 BOX of Item A" is the part that changes a decision.
  const orders: { id: string; docNo: string; dueDate: string | null; what: string[] }[] = [];
  for (const l of lines) {
    let o = orders.find((x) => x.id === l.order_id);
    if (!o) {
      o = { id: l.order_id, docNo: l.doc_no, dueDate: l.due_date, what: [] };
      orders.push(o);
    }
    o.what.push(`${l.item_name} · ${qty(l.outstanding)} ${l.uom_code}`);
  }

  const one = orders.length === 1;

  return (
    <div className="awaiting">
      <div className="awaiting-head">
        <AlertCircle size={15} aria-hidden="true" />
        <div>
          <strong>
            This {sales ? "customer" : "supplier"} has {orders.length} open{" "}
            {sales ? "sales" : "purchase"} order{one ? "" : "s"} awaiting{" "}
            {sales ? "delivery" : "goods"}.
          </strong>
          <span className="page-sub">
            {purpose === "order"
              ? <>Review {one ? "it" : "them"} before{" "}
                  {sales ? "promising" : "ordering"} the same goods again.</>
              : sales
                ? <>If this invoice is for {one ? "it" : "one of them"}, deliver
                    against the order first and bill that delivery. Invoicing
                    here sends goods of its own, and the order is still owed
                    what it ordered afterwards.</>
                : <>If this bill is for {one ? "it" : "one of them"}, receive
                    the goods against the order first and match this bill to
                    that receipt. Billing here raises a receipt of its own,
                    and the order is still owed the goods afterwards.</>}
          </span>
        </div>
      </div>

      <div className="tablewrap">
        <table className="linetable awaiting-table">
          <thead>
            <tr>
              <th>Existing order</th>
              <th>Still awaiting</th>
              <th>{sales ? "Wanted by" : "Needed by"}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{o.docNo}</td>
                <td>
                  {/* Three is as much as a reminder can say without becoming
                      the document itself; the rest is one click away. */}
                  {o.what.slice(0, 3).join(" · ")}
                  {o.what.length > 3 && ` · +${o.what.length - 3} more`}
                </td>
                <td>{o.dueDate ? shortDate(o.dueDate) : "—"}</td>
                <td className="awaiting-go">
                  {/* A new tab, deliberately: checking the old order must not
                      throw away the one being typed. */}
                  <Link href={`/documents/${o.id}`} target="_blank">
                    View order <ArrowUpRight size={12} aria-hidden="true" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="awaiting-foot">
        {purpose === "order"
          ? <>Nothing has been {sales ? "delivered" : "received"}, invoiced or
              paid against {one ? "this one" : "these"}. You can still{" "}
              {sales ? "take" : "place"} a separate order below.</>
          : <>Carry on below only if this is a separate{" "}
              {sales ? "sale" : "purchase"} — nothing here is blocked.</>}
      </p>
    </div>
  );
}

/**
 * The same warning, narrowed to one line of the new order.
 *
 * The banner says this supplier is owed goods; this says the goods on the
 * line being typed are the goods already coming. That is the sentence that
 * actually stops the duplicate, and it belongs against the line, not in a
 * paragraph above it.
 */
export function AlreadyAwaited({
  lines, sales,
}: { lines: AwaitingLine[]; sales: boolean }) {
  if (lines.length === 0) return null;

  const total = lines.reduce((t, l) => t + l.outstanding, 0);
  const where = [...new Set(lines.map((l) => l.doc_no))];

  return (
    <span className="awaiting-line">
      {qty(total)} {lines[0].uom_code} already{" "}
      {sales ? "promised" : "on order"} — {where.join(", ")}
    </span>
  );
}
