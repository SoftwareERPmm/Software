import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { qty, shortDate } from "@/lib/format";
import type { GrirCollisionLine } from "@/lib/queries";

/**
 * Goods waiting on a bill and a bill waiting on goods, for the same items —
 * said before a third document joins them.
 *
 * The receive form already warns while an order is still owed goods. This is
 * the state just after that: the order has been satisfied, so nothing is
 * outstanding on it and that warning has gone quiet, but the bill that came
 * before the goods is still sitting there waiting for goods that have already
 * arrived — under a different document, because a purchase invoice cannot
 * name the order it pays for.
 *
 * Receiving again closes that bill's GR/IR with a second set of goods, and
 * then nothing looks wrong at all: both halves clear, every document is
 * individually correct, and the only trace is twice the stock and two
 * payables. So this is the last moment anything can say it.
 *
 * It does not block. A supplier really can bill ahead for one delivery while
 * owing a bill for another, and only the person who spoke to them knows.
 */
export function MaybeSamePurchase({ lines }: { lines: GrirCollisionLine[] }) {
  if (lines.length === 0) return null;

  const side = (s: "GOODS" | "BILL") => {
    const docs: { id: string; docNo: string; date: string; what: string[] }[] = [];
    for (const l of lines.filter((x) => x.side === s)) {
      let d = docs.find((x) => x.id === l.document_id);
      if (!d) {
        d = { id: l.document_id, docNo: l.doc_no, date: l.doc_date, what: [] };
        docs.push(d);
      }
      d.what.push(`${l.item_name} · ${qty(l.qty)} ${l.uom_code}`);
    }
    return docs;
  };

  const goods = side("GOODS");
  const bills = side("BILL");

  return (
    <div className="awaiting">
      <div className="awaiting-head">
        <AlertCircle size={15} aria-hidden="true" />
        <div>
          <strong>Goods and a bill are both waiting, for the same items.</strong>
          <span className="page-sub">
            This is usually one purchase recorded twice. A bill that arrives
            before the goods cannot name the order it pays for, so the order
            and the bill each end up wanting a delivery of their own —
            receiving again brings the same goods in a second time.
          </span>
        </div>
      </div>

      <div className="tablewrap">
        <table className="linetable awaiting-table">
          <thead>
            <tr>
              <th>Document</th>
              <th>For</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {goods.map((d) => (
              <tr key={d.id}>
                <td>{d.docNo}</td>
                <td>{d.what.join(" · ")}</td>
                <td>in stock since {shortDate(d.date)}, waiting on a bill</td>
                <td className="awaiting-go">
                  <Link href={`/documents/${d.id}`} target="_blank">View receipt</Link>
                </td>
              </tr>
            ))}
            {bills.map((d) => (
              <tr key={d.id}>
                <td>{d.docNo}</td>
                <td>{d.what.join(" · ")}</td>
                <td>billed {shortDate(d.date)}, waiting on goods</td>
                <td className="awaiting-go">
                  <Link href={`/documents/${d.id}`} target="_blank">View bill</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="awaiting-foot">
        If they are one purchase, the bill belongs to the goods already here:
        void it and raise it again matched to that receipt. Carry on below only
        if this is a separate delivery — nothing here is blocked.
      </p>
    </div>
  );
}


/** One bill waiting for goods, as the fulfilment form needs to name it. */
export type WaitingBill = {
  id: string;
  doc_no: string;
  doc_date: string | Date;
  lines: { itemId: string; itemName: string; qty: number }[];
  /** Raised from this order, rather than merely from the same supplier for
   *  the same item. Only a bill that names this order's lines carries the
   *  allocation that closes it when the goods are received. */
  linked?: boolean;
};

/**
 * A bill already waiting for the goods this order is about to receive.
 *
 * Said before the first receipt, which is the step the collision notice
 * cannot reach: that one needs goods on one side and a bill on the other,
 * and here there are no goods yet. What there is, is a bill that has been
 * raised for these items and had nothing received against it — often the
 * very bill this order was billed from.
 *
 * Receiving here is not wrong, but it is the more expensive of the two
 * moves. Receiving against the bill matches the goods to that bill and
 * closes this order with it, because the receipt carries the allocation the
 * bill was filled with. Receiving against the order closes the order and
 * leaves the bill waiting for goods that have already arrived — which is
 * where the second receipt, and the doubled stock, came from.
 *
 * Not "clears what the supplier is owed", which is what this said and is not
 * what happens: receiving goods moves no money and settles no payable. The
 * supplier is still owed exactly what they were owed a moment ago. Matching
 * is a statement about which goods answer which bill, and a sentence that
 * implies a payment is one a person can act on wrongly.
 *
 * One bill matters here and the rest are guesses. A bill raised from this
 * order carries the allocation; the others merely come from the same
 * supplier for the same item, and eight of those listed beside the one real
 * answer bury it. The linked bill leads, with the action on it; the rest are
 * behind a disclosure that says how many there are.
 */
export function BillAwaitsTheseGoods({
  bills, orderNo, itemIds, remaining, unitWord,
}: {
  bills: WaitingBill[]; orderNo: string; itemIds: string[];
  /** What this order is still expecting, for the headline and the button. */
  remaining?: number;
  unitWord?: string | null;
}) {
  const relevant = bills
    .map((b) => ({ ...b, lines: b.lines.filter((l) => itemIds.includes(l.itemId)) }))
    .filter((b) => b.lines.length > 0);
  if (relevant.length === 0) return null;

  // The one raised from this order, if there is one. It is the only bill that
  // carries the allocation that closes the order when the goods land.
  const linked = relevant.find((b) => b.linked) ?? null;
  const others = relevant.filter((b) => b !== linked);
  const unit = unitWord ? ` ${unitWord}` : "";
  const still = remaining && remaining > 0 ? `${qty(remaining)}${unit}` : null;

  return (
    <div className="awaiting">
      {linked ? (
        <>
          <div className="awaiting-head">
            <AlertCircle size={15} aria-hidden="true" />
            <div>
              <strong>
                {still ? `${still} still expected` : "Still expected"}
                {" · "}
                Already billed on {linked.doc_no}
              </strong>
              <span className="page-sub">
                When these goods arrive, receive them against this bill to
                update both the bill and this order. Receiving here instead
                closes {orderNo} and leaves {linked.doc_no} waiting for goods
                that have already arrived.
              </span>
            </div>
          </div>
          <div className="awaiting-act">
            <Link className="btn" href={`/purchases/receive/new?match_invoice_id=${linked.id}`}>
              {still ? `Receive ${still} against bill` : "Receive against this bill"}
            </Link>
          </div>
        </>
      ) : (
        <div className="awaiting-head">
          <AlertCircle size={15} aria-hidden="true" />
          <div>
            <strong>
              {others.length === 1 ? "A bill is" : `${others.length} bills are`} already
              waiting for these goods.
            </strong>
            <span className="page-sub">
              {others.length === 1 ? "It is" : "They are"} for the same items from
              this supplier and may be the same purchase — check before receiving
              here. Nothing ties {others.length === 1 ? "it" : "them"} to {orderNo},
              so receiving against {others.length === 1 ? "it" : "one"} would match
              those goods to that bill without closing this order.
            </span>
          </div>
        </div>
      )}

      {others.length > 0 && (
        <details className="awaiting-others">
          <summary>
            {linked
              ? `Other possible bills from this supplier: View ${others.length}`
              : `All ${others.length}`}
          </summary>
          <div className="tablewrap">
            <table className="linetable awaiting-table">
              <thead>
                <tr><th>Bill</th><th>For</th><th>Raised</th><th /></tr>
              </thead>
              <tbody>
                {others.map((b) => (
                  <tr key={b.id}>
                    <td>{b.doc_no}</td>
                    <td>
                      {b.lines.map((l) => `${l.itemName} · ${qty(l.qty)}`).join(" · ")}
                    </td>
                    <td>
                      {shortDate(b.doc_date as string)}
                      <span className="awaiting-why"> · not linked to this order</span>
                    </td>
                    <td className="awaiting-go">
                      <Link href={`/purchases/receive/new?match_invoice_id=${b.id}`}>
                        Receive against this bill
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
