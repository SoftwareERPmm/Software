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
 * Bills raised from this order lead; guesses go behind a disclosure. A bill
 * that names this order's lines carries the allocation, and there can be more
 * than one of them — an order billed in two parts has two. Picking the first
 * and calling the rest "not linked to this order" was false about a bill that
 * names the same lines. The others merely come from the same supplier for the
 * same item, and eight of those listed beside the real answers bury them.
 *
 * No quantity on the buttons. Which bill covers how much of which order line
 * is decided by the posting rules against the quantity actually entered, and
 * belongs in the receiving preview once it is. Offering "Receive 100 against
 * bill" — the order's remaining, beside a bill awaiting forty — promised
 * something that bill could not do.
 */
export function BillAwaitsTheseGoods({
  bills, orderNo, itemIds, unitWord,
}: {
  bills: WaitingBill[]; orderNo: string; itemIds: string[];
  unitWord?: string | null;
}) {
  const relevant = bills
    .map((b) => ({ ...b, lines: b.lines.filter((l) => itemIds.includes(l.itemId)) }))
    .filter((b) => b.lines.length > 0);
  if (relevant.length === 0) return null;

  // Every bill raised from this order, not the first one found. An order can
  // be billed in parts — forty on one bill and sixty on another — and picking
  // one of them made the other a stranger: listed under "other possible
  // matches" and labelled "not linked to this order", which was false about a
  // bill that names this order's own lines.
  const linked = relevant.filter((b) => b.linked);
  const unlinked = relevant.filter((b) => !b.linked);
  const unit = unitWord ? ` ${unitWord}` : "";

  // What each bill is still waiting for, from that bill. Not the order's
  // remaining quantity, which belongs to the order and not to any one bill:
  // offering "Receive 100 against bill" beside a bill awaiting forty promised
  // something that bill cannot do.
  const awaiting = (b: typeof relevant[number]) =>
    b.lines.reduce((t, l) => t + Number(l.qty || 0), 0);

  return (
    <div className="awaiting">
      <div className="awaiting-head">
        <AlertCircle size={15} aria-hidden="true" />
        <div>
          <strong>
            {linked.length > 0
              ? `${linked.length} linked supplier bill${linked.length === 1 ? " is" : "s are"} awaiting goods.`
              : `${unlinked.length} possible matching bill${unlinked.length === 1 ? "" : "s"} found.`}
          </strong>
          <span className="page-sub">
            {linked.length > 0 ? (
              <>
                Select the bill covering this delivery. Receiving against it
                matches the goods to that bill and answers {orderNo} with them;
                receiving here instead leaves the bill waiting for goods that
                have arrived.
              </>
            ) : (
              /* "Already waiting for these goods" claimed a connection that
                 does not exist. Sharing a supplier and an item is a
                 resemblance, not a link, and a heading that states it as fact
                 invites somebody to receive against a bill belonging to a
                 different purchase entirely. */
              <>
                {unlinked.length === 1 ? "This shares" : "These share"} the
                supplier and items but {unlinked.length === 1 ? "is" : "are"} not
                linked to {orderNo}. Receiving against{" "}
                {unlinked.length === 1 ? "it" : "one"} would match those goods to
                that bill without answering this order.
              </>
            )}
          </span>
        </div>
      </div>

      {linked.length > 0 && (
        <div className="tablewrap">
          <table className="linetable awaiting-table">
            <thead>
              <tr>
                <th>Bills linked to this order</th>
                <th className="r">Awaiting receipt</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {linked.map((b) => (
                <tr key={b.id}>
                  <td>
                    {b.doc_no}
                    <span className="awaiting-why"> · {shortDate(b.doc_date as string)}</span>
                  </td>
                  <td className="r">{qty(awaiting(b))}{unit}</td>
                  <td className="awaiting-go">
                    {/* No quantity on this button. How much of this bill
                        answers which order line is decided by the posting
                        rules against the quantity actually entered, and is
                        shown in the receiving preview once it is. A figure
                        here would be a promise made before the calculation. */}
                    <Link href={`/purchases/receive/new?match_invoice_id=${b.id}`}>
                      Receive against this bill
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {unlinked.length > 0 && (
        <details className="awaiting-others">
          {/* "Other" only means something beside a list of linked bills. With
              none, the heading has already named these, so the disclosure
              just opens them. */}
          <summary>
            {linked.length > 0
              ? `Other possible matches (${unlinked.length})`
              : `Show ${unlinked.length === 1 ? "the bill" : `all ${unlinked.length}`}`}
          </summary>
          {linked.length > 0 && (
            <p className="awaiting-why" style={{ margin: "0 0 0.4rem" }}>
              These bills are not linked to this order.
            </p>
          )}
          <div className="tablewrap">
            <table className="linetable awaiting-table">
              <thead>
                <tr><th>Bill</th><th>For</th><th>Raised</th><th /></tr>
              </thead>
              <tbody>
                {unlinked.map((b) => (
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
        </details>
      )}
    </div>
  );
}
