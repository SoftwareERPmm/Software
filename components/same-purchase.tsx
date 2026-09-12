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
 * moves. Receiving against the bill clears what the supplier is owed and
 * now closes this order too, because the receipt carries the allocation the
 * bill was filled with. Receiving against the order closes the order and
 * leaves the bill waiting for goods that have already arrived — which is
 * where the second receipt, and the doubled stock, came from.
 */
export function BillAwaitsTheseGoods({
  bills, orderNo, itemIds,
}: { bills: WaitingBill[]; orderNo: string; itemIds: string[] }) {
  const relevant = bills
    .map((b) => ({ ...b, lines: b.lines.filter((l) => itemIds.includes(l.itemId)) }))
    .filter((b) => b.lines.length > 0);
  if (relevant.length === 0) return null;

  const one = relevant.length === 1;

  return (
    <div className="awaiting">
      <div className="awaiting-head">
        <AlertCircle size={15} aria-hidden="true" />
        <div>
          <strong>
            {one ? "A bill is" : `${relevant.length} bills are`} already waiting
            for these goods.
          </strong>
          <span className="page-sub">
            Receive against {one ? "it" : "one of them"} instead: that clears
            what the supplier is owed, and {orderNo} closes itself when it
            does. Receiving here closes {orderNo} and leaves{" "}
            {one ? "the bill" : "them"} waiting for goods that have arrived.
          </span>
        </div>
      </div>

      <div className="tablewrap">
        <table className="linetable awaiting-table">
          <thead>
            <tr><th>Bill</th><th>For</th><th>Raised</th><th /></tr>
          </thead>
          <tbody>
            {relevant.map((b) => (
              <tr key={b.id}>
                <td>{b.doc_no}</td>
                <td>
                  {b.lines.map((l) => `${l.itemName} · ${qty(l.qty)}`).join(" · ")}
                </td>
                <td>{shortDate(b.doc_date as string)}</td>
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
    </div>
  );
}
