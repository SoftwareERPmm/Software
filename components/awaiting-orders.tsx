import Link from "next/link";
import { AlertCircle, ArrowUpRight } from "lucide-react";
import { qty, shortDate } from "@/lib/format";
import type { AwaitingLine } from "@/lib/queries";

/**
 * What this partner is already waiting for, said before the same thing is
 * ordered twice.
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
  lines, sales,
}: { lines: AwaitingLine[]; sales: boolean }) {
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
            Review {one ? "it" : "them"} before{" "}
            {sales ? "promising" : "ordering"} the same goods again.
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
        Nothing has been {sales ? "delivered" : "received"}, invoiced or paid
        against {one ? "this one" : "these"}. You can still{" "}
        {sales ? "take" : "place"} a separate order below.
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
