"use client";

import { useActionState, useEffect, useState } from "react";
import type { ActionResult, PickerItem } from "@/lib/actions";
import type { AwaitingLine } from "@/lib/queries";
import { ItemPicker } from "./item-picker";
import { PartnerPicker } from "./partner-picker";
import Link from "next/link";
import { AwaitingOrders, AlreadyAwaited } from "./awaiting-orders";
import { useBackHere } from "./back-here";
import { PackageCheck, Truck, Clock } from "lucide-react";

type Item = PickerItem;
type Node = { id: string; code: string; segment: string; name: string; parent_id: string | null };

type Partner = { id: string; code: string; name: string; payment_terms_days: number };
type Location = { id: string; code: string; name: string };
type CashAccount = { id: string; code: string; name: string };
type MatchLine = {
  lineId: string; itemId: string; itemCode: string; itemName: string;
  qty: number; unitPrice: number;
  /** The unit those goods were received in, and the same remainder counted
   *  in it — the unit the price belongs to. */
  uomId?: string | null;
  factor?: number;
  enteredQty?: number;
  /** What the purchase order agreed, where the receipt came in against one. */
  orderPrice?: number | null;
  orderId?: string | null;
  orderNo?: string | null;
};
type OpenDoc = {
  id: string; doc_no: string; doc_date: string; partner_id: string;
  /** Where the goods went, so a bill for them opens on that warehouse. */
  location_id?: string | null;
  /** The purchase order this receipt came in against, when it came from one. */
  source_no?: string | null;
  lines: MatchLine[];
};

// sourceLineId is set only when the line was prefilled from a goods receipt.
// It is what lets GR/IR be settled at the rate that particular line came in
// at, rather than at an average across every line of the same item.
type Line = {
  key: number; itemId: string; qty: string; unitPrice: string;
  /** The unit the quantity and price are in. Empty means the item's own
   *  unit, which is every line not filled from a packed receipt. */
  uomId?: string;
  sourceLineId?: string;
  /**
   * The order line this one bills, when the voucher was filled from an open
   * order. Kept apart from sourceLineId, which means "prefilled from a goods
   * receipt" and locks the quantity to what arrived: an order is a promise,
   * and the supplier may well bill a different amount of it.
   */
  orderLineId?: string;
  /** What the source still has unbilled — the ceiling on this line. */
  sourceQty?: string;
};

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

function addDays(iso: string, days: number) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function InvoiceForm({
  kind,
  action,
  partners,
  items: initialItems,
  locations,
  today,
  categories,
  uoms,
  cashAccounts,
  goodsReceipts,
  initialGoodsReceiptId,
  awaiting = [],
  taxCodes = [],
}: {
  kind: "sales" | "purchase";
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  partners: Partner[];
  items: Item[];
  locations: Location[];
  today: string;
  categories: Node[];
  uoms: { id: string; code: string; name: string }[];
  cashAccounts?: CashAccount[];
  /** Orders to this partner with goods still owed. See getOpenOrdersAwaitingGoods. */
  awaiting?: AwaitingLine[];
  /** Open (unmatched) goods receipts this invoice can match against — purchase only. */
  goodsReceipts?: OpenDoc[];
  /** Arrived via "Create purchase invoice" on a specific receipt's own page — match it immediately. */
  initialGoodsReceiptId?: string;
  /** Commercial tax codes this company can be charged, zero rate first. */
  taxCodes?: {
    id: string; code: string; name: string;
    /** Every rate this code has carried, oldest first. */
    rates: { rate: string | number; validFrom: string }[];
  }[];
}) {
  const backHere = useBackHere();
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  /** See the hidden field below. */
  const [attemptKey] = useState(() => crypto.randomUUID());

  const [items, setItems] = useState<Item[]>(initialItems);
  const addItem = (i: Item) => setItems((xs) => [...xs, i]);

  const [lines, setLines] = useState<Line[]>([{ key: 1, itemId: "", qty: "", unitPrice: "" }]);
  const [partnerId, setPartnerId] = useState("");
  const [docDate, setDocDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [cashOut, setCashOut] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [matchedGrId, setMatchedGrId] = useState("");
  /**
   * Which of the three ways this bill can post. The engine has always had
   * three — matched to a receipt that already exists, composing a fresh one,
   * or deferred so only the payable side lands — and the form expressed them
   * as a select in the header plus a checkbox two screens down, default on.
   * Whether stock moves was decided by a tick that was easy to miss and
   * easier to leave alone by accident. It is one question now, asked once,
   * with all three answers visible and none of them pre-chosen silently.
   */
  const [receiveMode, setReceiveMode] = useState<"match" | "now" | "later">("now");
  /**
   * Which warehouse this bill is for. Follows the receipt being matched: an
   * invoice billing goods that went into Magway is an invoice for Magway, and
   * asking again is asking a question whose answer is already on the screen.
   */
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  /**
   * Bill less than arrived — asked for, not typed into.
   *
   * A line filled from a receipt carries that receipt's quantity and is not
   * editable, which is right: an invoice for 110 against 100 received is a
   * mistake, and one for 60 typed over 100 is indistinguishable from a
   * typo. But billing part of a delivery is ordinary — half the load now,
   * half when the rest clears customs — so it needs a way to be said, and
   * saying it deliberately is the difference. Ticking this opens the
   * quantities and caps each at what that line still has unbilled; the rest
   * stays on the receipt, waiting for the next bill.
   */
  const [billPart, setBillPart] = useState(false);
  const [reference, setReference] = useState("");
  /** Which open order this bill was filled from, if any. */
  const [fromOrderId, setFromOrderId] = useState<string | null>(null);

  const isSales = kind === "sales";
  const byId = (id: string) => items.find((i) => i.id === id);

  /**
   * A line that came from somewhere else, and so is not this voucher's to
   * change: a receipt line (what arrived, arrived) or an order line (the
   * item, quantity and price were agreed there). Either way the way to
   * change it is at the document it came from — enforced on the server too,
   * in assertOrderTerms and assertSourceLines.
   */
  const inherited = (l: Line) => !!(l.sourceLineId || l.orderLineId);
  const openReceipts = (goodsReceipts ?? []).filter((d) => d.partner_id === partnerId);
  const matchedGr = openReceipts.find((d) => d.id === matchedGrId) ?? null;

  /**
   * Opened from one goods receipt's own page rather than from a blank form.
   *
   * Everything the receipt already decides is then settled rather than
   * asked: which supplier, which warehouse, which receipt, and that the
   * goods are already in. Offering those as questions invites an answer that
   * contradicts the document the reader is standing on — and a supplier with
   * three open receipts makes the contradiction easy.
   */
  const fromReceipt = Boolean(initialGoodsReceiptId);
  const sourceGr = (goodsReceipts ?? []).find((d) => d.id === initialGoodsReceiptId) ?? null;
  const sourcePartner = partners.find((p) => p.id === sourceGr?.partner_id) ?? null;
  const sourceLocation = locations.find((l) => l.id === sourceGr?.location_id) ?? null;

  /**
   * Orders from this supplier still owed goods. Suppressed once a receipt is
   * matched: that bill is answering goods already in the warehouse, which is
   * the correct path and not the mistake this warns about.
   */
  const awaited = !partnerId || matchedGrId
    ? []
    : awaiting.filter((a) => a.partner_id === partnerId);

  /**
   * Our own number for the job this bill belongs to — the purchase order it
   * traces back to, or the receipt itself when it came in without one.
   *
   * Filled in rather than left blank because stepping order → receipt →
   * invoice already knows the answer, and making someone copy it across from
   * another screen is how a bill ends up with no order on it at all. It stays
   * an ordinary input: the supplier's own invoice number can be typed over it.
   */
  const referenceFor = (d: OpenDoc) => d.source_no || d.doc_no;

  function matchGoodsReceipt(id: string) {
    setMatchedGrId(id);
    if (id) setReceiveMode("match");
    setBillPart(false);
    const gr = openReceipts.find((d) => d.id === id);
    if (!gr) return;
    if (gr.location_id) setLocationId(gr.location_id);
    setLines(
      gr.lines.map((l, idx) => ({
        key: idx + 1,
        itemId: l.itemId,
        // Billed in the unit the goods came in, because that is the unit the
        // price is per: five cartons at 12,000, not a hundred and twenty
        // pieces at 12,000 apiece.
        qty: String(l.enteredQty ?? l.qty),
        uomId: l.uomId ?? undefined,
        unitPrice: String(l.unitPrice),
        sourceLineId: l.lineId,
        sourceQty: String(l.enteredQty ?? l.qty),
      }))
    );
    setFromOrderId(null);
  }

  /**
   * Fill this bill from an open order: the items still owed on it, the
   * quantities still owed, and the price agreed on it.
   *
   * Copying the numbers, not claiming a link. The order number goes in the
   * reference field, which is what that field is for — a bill can only name
   * a goods receipt as its source, so the chain is closed later, when the
   * goods arrive and the receipt is linked to the order it answered.
   *
   * Quantities are the outstanding ones rather than the ordered ones: a bill
   * for what has already arrived on an earlier receipt would be billing it
   * twice, which is the thing this whole notice exists to prevent.
   */
  function fillFromOrder(orderId: string) {
    const rows = awaited.filter((a) => a.order_id === orderId);
    if (rows.length === 0) return;
    setFromOrderId(orderId);
    setBillPart(false);
    setLines(rows.map((r, idx) => ({
      key: idx + 1,
      itemId: r.item_id,
      qty: String(r.outstanding),
      unitPrice: String(r.unit_price),
      orderLineId: r.order_line_id,
      // What the order still has to be billed — the ceiling on this line,
      // and the figure "Bill part" counts down from.
      sourceQty: String(r.outstanding),
    })));
    setReference(rows[0].doc_no);
  }

  // Arrived from a specific receipt's own page — its supplier isn't chosen
  // yet at this point, so this searches the full list rather than
  // openReceipts (which only exists once a supplier is picked).
  useEffect(() => {
    if (!initialGoodsReceiptId) return;
    const gr = (goodsReceipts ?? []).find((d) => d.id === initialGoodsReceiptId);
    if (!gr) return;
    setPartnerId(gr.partner_id);
    setMatchedGrId(gr.id);
    /* And says so. Without this the screen offered "Arriving with this bill"
       with the receipt's own lines already filled in, so posting would have
       received the same goods a second time — the mode has to follow the
       document the reader came from. */
    setReceiveMode("match");
    if (gr.location_id) setLocationId(gr.location_id);
    // Only when the invoice was opened from a receipt — walking the chain is
    // what makes the order relevant. Someone who opened a blank invoice and
    // chose a receipt from the list is composing it themselves.
    setReference(referenceFor(gr));
    setLines(
      gr.lines.map((l, idx) => ({
        key: idx + 1,
        itemId: l.itemId,
        // Billed in the unit the goods came in, because that is the unit the
        // price is per: five cartons at 12,000, not a hundred and twenty
        // pieces at 12,000 apiece.
        qty: String(l.enteredQty ?? l.qty),
        uomId: l.uomId ?? undefined,
        unitPrice: String(l.unitPrice),
        sourceLineId: l.lineId,
        sourceQty: String(l.enteredQty ?? l.qty),
      }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialGoodsReceiptId]);

  function billWholeReceipt(part: boolean) {
    setBillPart(part);
    if (!part) {
      setLines((ls) => ls.map((l) => (l.sourceQty ? { ...l, qty: l.sourceQty } : l)));
    }
  }

  function setLine(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickItem(key: number, itemId: string) {
    const item = byId(itemId);
    const price = !item ? "" : isSales ? item.sale_price : item.next_cost;
    // Changing the item detaches the line from the receipt line it was
    // prefilled from — that reference belonged to the old item.
    setLine(key, {
      itemId,
      unitPrice: Number(price) > 0 ? String(Number(price)) : "",
      sourceLineId: undefined,
    });
  }

  function pickPartner(id: string) {
    setPartnerId(id);
    setMatchedGrId("");
    setFromOrderId(null);
    const p = partners.find((x) => x.id === id);
    if (p && p.payment_terms_days > 0) setDueDate(addDays(docDate, p.payment_terms_days));
  }

  /**
   * Leaving "matched" drops the receipt it was matched to. Keeping it would
   * send goods_receipt_id alongside a choice that says no receipt exists,
   * and the engine reads the id first — so the screen would say one thing
   * and the posting do another.
   */
  function chooseReceiveMode(m: "match" | "now" | "later") {
    setReceiveMode(m);
    if (m !== "match" && matchedGrId) setMatchedGrId("");
  }

  const addLine = () =>
    setLines((ls) => [...ls, { key: Math.max(0, ...ls.map((l) => l.key)) + 1, itemId: "", qty: "", unitPrice: "" }]);

  const removeLine = (key: number) =>
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((l) => l.key !== key)));

  const amount = (l: Line) => (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
  const goodsTotal = lines.reduce((s, l) => s + amount(l), 0);

  /* Input tax on a supplier bill. Same split the engine does — a wholesaler
     here usually quotes with the tax inside the price, so inclusive is worth
     one click rather than a calculator. */
  /* What each code charges on the date this document is dated — not on the
     date the page was opened. A rate that started in September does not
     apply to an invoice being written up for August. */
  const rateOn = (t: { rates: { rate: string | number; validFrom: string }[] }) => {
    const inForce = (t.rates ?? []).filter((r) => r.validFrom <= docDate);
    return inForce.length ? Number(inForce[inForce.length - 1].rate) : null;
  };
  const effective = taxCodes
    .map((t) => ({ ...t, rate: rateOn(t) }))
    .filter((t) => t.rate !== null) as (typeof taxCodes[number] & { rate: number })[];
  const taxable = effective.filter((t) => t.rate > 0);
  const zeroRated = effective.find((t) => t.rate === 0) ?? null;
  const [taxCodeId, setTaxCodeId] = useState<string>(zeroRated?.id ?? "");
  const [inclusive, setInclusive] = useState(false);
  const taxRate = effective.find((t) => t.id === taxCodeId)?.rate ?? 0;
  const rTax = (n: number) => Math.round(n);
  const taxOnGoods = taxRate === 0 ? 0
    : inclusive ? rTax(goodsTotal - rTax(goodsTotal / (1 + taxRate / 100)))
    : rTax((goodsTotal * taxRate) / 100);
  const goodsNet = inclusive ? goodsTotal - taxOnGoods : goodsTotal;
  const total = goodsNet + taxOnGoods;

  const payload = JSON.stringify(
    lines
      .filter((l) => l.itemId && Number(l.qty) > 0)
      .map((l) => ({
        itemId: l.itemId,
        qty: Number(l.qty),
        // Which unit that quantity is in. Without it a bill for five cartons
        // would reach the engine as five pieces — and on the buying side it
        // would put five on the shelf instead of a hundred and twenty.
        uomId: l.uomId || null,
        unitPrice: Number(l.unitPrice) || 0,
        taxCodeId: taxCodeId || null,
        // Whichever this line came from. A receipt line and an order line
        // never both apply — matching a receipt replaces the lines.
        sourceLineId: l.sourceLineId ?? l.orderLineId,
      }))
  );

  // Warn before submitting rather than after the server rejects it.
  const shortages = lines.filter((l) => {
    if (!isSales || !l.itemId) return false;
    const item = byId(l.itemId);
    return item?.is_stocked && Number(l.qty) > Number(item.on_hand);
  });

  const qtyMismatches = matchedGr
    ? lines.filter((l) => {
        const receivedLine = matchedGr.lines.find((gl) => gl.itemId === l.itemId);
        return receivedLine && Number(l.qty) !== receivedLine.qty;
      })
    : [];

  /**
   * Three prices, kept apart: what the order agreed, what the goods came in
   * at, and what the supplier is billing. Only shown when there is an order
   * behind the receipt — without one there is no agreement to be at odds
   * with, and an empty column would only suggest something is missing.
   */
  const anyOrdered = !!matchedGr
    && matchedGr.lines.some((gl) => gl.orderPrice !== null && gl.orderPrice !== undefined);

  const priceGaps = anyOrdered
    ? lines.filter((l) => {
        const gl = matchedGr!.lines.find((x) => x.itemId === l.itemId);
        const ordered = gl?.orderPrice ?? null;
        return ordered !== null && Math.abs(Number(l.unitPrice) - ordered) > 0.0001;
      })
    : [];

  const orderBehind = matchedGr?.lines.find((gl) => gl.orderId) ?? null;

  const cashOverpaid = !isSales && Number(cashOut) > total;
  const leavesBalance = !isSales && Number(cashOut) < total;

  return (
    <form action={formAction} className="form wide">
      {/* One submission, one posting. Generated when this form mounts, so a
          double-click or a resent request carries the same key and is handed
          the document the first one posted; a new form is a new key. */}
      <input type="hidden" name="idempotency_key" value={attemptKey} />

      {state && "error" in state && <div className="alert">{state.error}</div>}

      <input type="hidden" name="lines" value={payload} />

      <div className="card doc-meta">
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="partner_id">{isSales ? "Customer" : "Supplier"}</label>
              {fromReceipt ? (
                <>
                  <span className="fixedfield">
                    {sourcePartner ? `${sourcePartner.code} · ${sourcePartner.name}` : "—"}
                  </span>
                  <input type="hidden" name="partner_id" value={partnerId} />
                  <span className="hint">From {sourceGr?.doc_no}</span>
                </>
              ) : (
                <PartnerPicker
                  partners={partners as never}
                  value={partnerId}
                  placeholder={isSales ? "Type a customer…" : "Type a supplier…"}
                  onPick={pickPartner}
                />
              )}
            </div>

            <div className="field">
              <label htmlFor="location_id">Warehouse</label>
              {fromReceipt ? (
                <>
                  <span className="fixedfield">
                    {sourceLocation ? `${sourceLocation.code} · ${sourceLocation.name}` : "—"}
                  </span>
                  <input type="hidden" name="location_id" value={locationId} />
                  <span className="hint">Where the goods were received</span>
                </>
              ) : (
                <select id="location_id" name="location_id" value={locationId}
                        onChange={(e) => setLocationId(e.target.value)} required>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code} · {l.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="field">
              <label htmlFor="doc_date">Invoice date</label>
              <input
                id="doc_date"
                name="doc_date"
                type="date"
                value={docDate}
                onChange={(e) => setDocDate(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="due_date">Due date</label>
              <input
                id="due_date"
                name="due_date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                required={leavesBalance}
              />
              <span className="hint">
                {leavesBalance ? "Filled from payment terms — required so this can be tracked as overdue" : "Filled from payment terms"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* The one question that decides whether stock moves. Three cards
          because the engine has three paths, worded as the situation rather
          than as the mechanism — somebody entering a bill knows whether the
          goods are in the warehouse; they do not know what GR/IR clearing is. */}
      {!isSales && (
        <div className="card receive-mode">
          <div className="card-head">
            <h2>Have the goods arrived?</h2>
            <span className="page-sub">This decides whether stock moves when the bill posts.</span>
          </div>
          <div className="card-body">
            <div className="modes" role="radiogroup" aria-label="Goods receipt status">
              {([
                {
                  key: "match" as const,
                  icon: <PackageCheck size={18} aria-hidden="true" />,
                  title: "Already received",
                  lead: "A goods receipt recorded them. This bill matches it.",
                  note: fromReceipt
                    ? `Chosen for you — you came from ${sourceGr?.doc_no}`
                    : partnerId
                      ? openReceipts.length > 0
                        ? `${openReceipts.length} receipt${openReceipts.length === 1 ? "" : "s"} waiting on a bill`
                        : "Nothing from this supplier is waiting on a bill"
                      : "Choose a supplier first",
                  disabled: !fromReceipt && (!partnerId || openReceipts.length === 0),
                  why: null,
                },
                {
                  key: "now" as const,
                  icon: <Truck size={18} aria-hidden="true" />,
                  title: "Arriving with this bill",
                  lead: "No receipt was raised. Posting records the goods in too.",
                  note: "A goods receipt posts alongside the bill",
                  disabled: fromReceipt,
                  why: fromReceipt ? "A goods receipt already recorded these goods" : null,
                },
                {
                  key: "later" as const,
                  icon: <Clock size={18} aria-hidden="true" />,
                  title: "Not yet arrived",
                  lead: "Bill first. Only what you owe posts now.",
                  note: "Receive them later from Purchases → Goods receipts",
                  disabled: fromReceipt,
                  why: fromReceipt ? "A goods receipt already recorded these goods" : null,
                },
              ]).map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="radio"
                  aria-checked={receiveMode === m.key}
                  className={`mode${receiveMode === m.key ? " on" : ""}`}
                  disabled={m.disabled}
                  onClick={() => chooseReceiveMode(m.key)}
                >
                  <span className="mode-icon">{m.icon}</span>
                  <span className="mode-text">
                    <strong>{m.title}</strong>
                    <span className="mode-lead">{m.lead}</span>
                    <span className="mode-note">{m.why ?? m.note}</span>
                  </span>
                </button>
              ))}
            </div>

            {/* Only under the choice it belongs to. In the header it was a
                field somebody scrolled past on the way to the lines. */}
            {receiveMode === "match" && fromReceipt && (
              <div className="field" style={{ marginTop: "1rem", maxWidth: "32rem" }}>
                <label>Which goods receipt</label>
                <span className="fixedfield">
                  {sourceGr?.doc_no}
                  {sourceGr?.doc_date ? ` · ${String(sourceGr.doc_date).slice(0, 10)}` : ""}
                </span>
                <input type="hidden" name="goods_receipt_id" value={matchedGrId} />
                <span className="hint">
                  The receipt you came from. Its lines are below, and posting links
                  the bill to it.
                </span>
              </div>
            )}

            {receiveMode === "match" && !fromReceipt && (
              <div className="field" style={{ marginTop: "1rem", maxWidth: "32rem" }}>
                <label htmlFor="goods_receipt_id">Which goods receipt</label>
                <select id="goods_receipt_id" name="goods_receipt_id" value={matchedGrId}
                  onChange={(e) => matchGoodsReceipt(e.target.value)}
                  disabled={!partnerId} required>
                  <option value="">Choose the receipt this bill is for…</option>
                  {openReceipts.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.doc_no} · {String(d.doc_date).slice(0, 10)} · {d.lines.length} line{d.lines.length === 1 ? "" : "s"}
                    </option>
                  ))}
                </select>
                <span className="hint">
                  {matchedGr
                    ? "Lines filled from it — check them against the actual bill"
                    : "Its lines and costs fill this bill in"}
                </span>
              </div>
            )}

            {/* Sent only when it is the answer. The engine reads
                goods_receipt_id first and received_now second, so a stale
                value from an abandoned choice would decide the posting. */}
            {receiveMode === "now" && (
              <input type="hidden" name="received_now" value="1" />
            )}
          </div>
        </div>
      )}


      {/* An open order this bill may belong to. The dangerous path is the
          quiet one: no receipt matched, "received now" left ticked, and the
          voucher raises a receipt of its own while the order goes on waiting
          for goods that have already arrived once. */}
      <AwaitingOrders
        lines={awaited}
        sales={isSales}
        purpose="bill"
        backTo={isSales ? "/sales/new" : "/purchases/new"}
        onUse={fillFromOrder}
        usedOrderId={fromOrderId}
      />

      <div className="card">
        <div className="card-head">
          <h2>Lines</h2>
          {lines.some(inherited) && (
            <label className="billpart">
              <input
                type="checkbox"
                checked={billPart}
                onChange={(e) => billWholeReceipt(e.target.checked)}
              />
              {lines.some((l) => l.orderLineId)
                ? "Bill part of the order"
                : "Bill only part of what arrived"}
            </label>
          )}
          <button type="button" className="ghost tiny" onClick={addLine}>
            Add line
          </button>
        </div>
        {billPart && (
          <p className="hint" style={{ padding: "0 1rem 0.5rem" }}>
            Reduce a quantity to bill less than{" "}
            {lines.some((l) => l.orderLineId) ? "the order asked for" : "arrived"}.
            Whatever is left stays on{" "}
            {lines.some((l) => l.orderLineId)
              ? (reference || "the order")
              : (matchedGr?.doc_no ?? "the receipt")}
            , waiting for the next bill — it is not written off.
          </p>
        )}

        <div className="tablewrap">
          <table className="linetable">
            <thead>
              <tr>
                <th>Item</th>
                <th className="r">{isSales ? "On hand" : "Next cost"}</th>
                {matchedGr && <th className="r">Received</th>}
                {anyOrdered && <th className="r">Order price</th>}
                <th className="r">Qty</th>
                <th className="r">{matchedGr ? "Billed price" : "Unit price"}</th>
                <th className="r">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const item = byId(l.itemId);
                const short = isSales && item?.is_stocked && Number(l.qty) > Number(item.on_hand);
                const receivedLine = matchedGr?.lines.find((gl) => gl.itemId === l.itemId);
                // Compared in the unit the line is written in: five cartons
                // billed against five cartons received is not a mismatch,
                // and comparing five to a hundred and twenty would say so.
                const qtyMismatch = matchedGr && receivedLine
                  && Number(l.qty) !== (receivedLine.enteredQty ?? receivedLine.qty);
                // Three figures, not one: what was agreed, what arrived at,
                // and what the supplier is now asking. They usually match, and
                // the times they do not are the times somebody has to decide
                // something.
                const ordered = receivedLine?.orderPrice ?? null;
                const priceGap = ordered !== null
                  && Math.abs(Number(l.unitPrice) - ordered) > 0.0001;

                return (
                  <tr key={l.key}>
                    <td style={{ minWidth: 240 }}>
                      {/* An order line's item is not this voucher's to swap:
                          changing what is being bought starts at the order. */}
                      {l.orderLineId ? (
                        <span className="readout" title="On the order — change it there">
                          {item ? `${item.code} · ${item.name}` : "—"}
                        </span>
                      ) : (
                        <ItemPicker
                          mode={kind}
                          items={items}
                          categories={categories}
                          uoms={uoms}
                          value={l.itemId}
                          onPick={(id) => pickItem(l.key, id)}
                          onCreated={addItem}
                        />
                      )}
                      {/* This line is the goods an open order is waiting for.
                          The banner says the order exists; this says the bill
                          being typed is for the same thing. */}
                      <AlreadyAwaited
                        lines={awaited.filter((a) => a.item_id === l.itemId)}
                        sales={isSales}
                        backTo={isSales ? "/sales/new" : "/purchases/new"}
                      />
                    </td>
                    <td className="r">
                      {!item ? (
                        "—"
                      ) : isSales ? (
                        <span style={{ color: short ? "var(--bad)" : undefined }}>
                          {item.is_stocked ? fmt(Number(item.on_hand)) : "service"}
                        </span>
                      ) : (
                        fmt(Number(item.next_cost))
                      )}
                    </td>
                    {matchedGr && (
                      <td className="r" style={{ color: qtyMismatch ? "var(--warn)" : undefined }}>
                        {receivedLine ? fmt(receivedLine.enteredQty ?? receivedLine.qty) : "—"}
                      </td>
                    )}
                    {anyOrdered && (
                      <td className="r" style={{ color: priceGap ? "var(--warn)" : undefined }}>
                        {ordered === null ? "—" : fmt(ordered)}
                      </td>
                    )}
                    <td className="narrow">
                      {/* What arrived, arrived, and what was agreed was
                          agreed. A line billing a receipt takes its quantity
                          from that receipt; a line filled from an order takes
                          item, quantity and price from the order. Neither is
                          typed over here — billing less is said deliberately,
                          with "Bill part", and capped at what is left. */}
                      <input
                        type="number"
                        min="0"
                        step="any"
                        max={inherited(l) && billPart ? l.sourceQty : undefined}
                        value={l.qty}
                        onChange={(e) => setLine(l.key, { qty: e.target.value })}
                        aria-label="Quantity"
                        readOnly={inherited(l) && !billPart}
                        title={l.sourceLineId && receivedLine
                          ? `${fmt(receivedLine.qty)} received on ${matchedGr?.doc_no}`
                          : l.orderLineId
                            ? `${fmt(Number(l.sourceQty ?? 0))} still to bill on the order`
                            : undefined}
                        style={inherited(l) && !billPart
                          ? { background: "var(--line-soft)", cursor: "not-allowed" }
                          : qtyMismatch ? { borderColor: "var(--warn)" } : undefined}
                      />
                      {inherited(l) && billPart
                       && Number(l.qty) < Number(l.sourceQty) - 0.0001 && (
                        <span className="qtyleft">
                          {fmt(Number(l.sourceQty) - Number(l.qty))} left to bill
                        </span>
                      )}
                    </td>
                    <td className="narrow">
                      {/* The price on an order line is the agreed one and is
                          changed at the order. On a receipt line it stays
                          open: the supplier's bill is external truth, and a
                          difference there is what variance exists for. */}
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={l.unitPrice}
                        onChange={(e) => setLine(l.key, { unitPrice: e.target.value })}
                        aria-label="Unit price"
                        readOnly={!!l.orderLineId}
                        title={l.orderLineId ? "Agreed on the order — change it there" : undefined}
                        style={l.orderLineId
                          ? { background: "var(--line-soft)", cursor: "not-allowed" }
                          : undefined}
                      />
                    </td>
                    <td className="r">{fmt(amount(l))}</td>
                    <td className="tight">
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => removeLine(l.key)}
                        aria-label="Remove line"
                        disabled={lines.length === 1}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="totalbar">
          {taxable.length > 0 && (
            <label className="totalbar-tax">
              <span style={{ color: "var(--muted)" }}>Commercial tax</span>
              <select
                value={taxCodeId}
                onChange={(e) => setTaxCodeId(e.target.value)}
                aria-label="Commercial tax"
              >
                {zeroRated && <option value={zeroRated.id}>None</option>}
                {taxable.map((t) => (
                  <option key={t.id} value={t.id}>{t.code} · {t.rate}%</option>
                ))}
              </select>
            </label>
          )}
          {taxRate > 0 && (
            <label className="totalbar-tax" title="The supplier's prices already contain the tax">
              <input
                type="checkbox"
                name="price_includes_tax"
                checked={inclusive}
                onChange={(e) => setInclusive(e.target.checked)}
              />
              <span style={{ color: "var(--muted)" }}>Prices include tax</span>
            </label>
          )}
          {taxOnGoods > 0 && (
            <span style={{ color: "var(--muted)" }}>
              goods {fmt(goodsNet)} + tax {fmt(taxOnGoods)}
            </span>
          )}
          <span style={{ color: "var(--muted)" }}>Total</span>
          <span className="big">{fmt(total)} MMK</span>
        </div>
      </div>

      {shortages.length > 0 && (
        <div className="alert">
          Not enough stock for{" "}
          {shortages.map((l) => byId(l.itemId)?.code).join(", ")}. Posting will be
          rejected — reduce the quantity or receive stock first.
        </div>
      )}

      {qtyMismatches.length > 0 && (
        <div className="alert" style={{ borderColor: "var(--warn)", color: "var(--warn)", background: "color-mix(in srgb, var(--warn) 8%, transparent)" }}>
          Billed quantity doesn&rsquo;t match what {matchedGr?.doc_no} recorded as received for{" "}
          {qtyMismatches.map((l) => byId(l.itemId)?.code ?? matchedGr?.lines.find((gl) => gl.itemId === l.itemId)?.itemCode).join(", ")}.
          Not blocked — a partial delivery or short shipment can be legitimate — but check before posting.
        </div>
      )}

      {/* The bill disagrees with the order. Not blocked: the supplier's
          invoice is what will be paid, and a price that moved between
          ordering and delivery is an ordinary fact. What matters is that
          somebody decides which of the two is now true, rather than posting
          past it — so both are named, and the way to make the order agree is
          offered rather than described. */}
      {priceGaps.length > 0 && (
        <div className="alert" style={{ borderColor: "var(--warn)", color: "var(--warn)", background: "color-mix(in srgb, var(--warn) 8%, transparent)" }}>
          The supplier is billing a different price from{" "}
          {orderBehind?.orderNo ?? "the order"} for{" "}
          {priceGaps.map((l) => byId(l.itemId)?.code
            ?? matchedGr?.lines.find((gl) => gl.itemId === l.itemId)?.itemCode).join(", ")}.
          {" "}The bill posts at what is typed here, and the difference goes back
          onto the goods: onto the stock still held, and to cost of sales for
          whatever has already been sold. If the new price is the agreed one,{" "}
          {orderBehind?.orderId
            ? <Link href={backHere(orderBehind.orderId)}>
                correct {orderBehind.orderNo}
              </Link>
            : "correct the order"} instead, and it will carry into this bill.
        </div>
      )}

      {/* Paid now and the rest of the paperwork, side by side. Stacked they
          were three blocks down the page — a card, a lone reference field,
          then a note — and the submit button fell below the fold on a laptop
          for a form whose last two fields are optional. The sales voucher
          already pairs its footer cards this way; this is the same grid,
          which collapses to one column under 320px per card. */}
      <div className="grid2">
      {!isSales && (
        <div className="card" style={{ marginTop: "0.5rem" }}>
          <div className="card-head">
            <h2>Payment</h2>
          </div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="cash_out">Amount paid</label>
                <input id="cash_out" name="cash_out" type="number" min="0" step="any"
                  value={cashOut} onChange={(e) => setCashOut(e.target.value)}
                  placeholder="0" />
                <span className="hint">Leave blank for a fully credit purchase</span>
              </div>

              <div className="field">
                <label htmlFor="cash_account_id">Paid from</label>
                <select id="cash_account_id" name="cash_account_id" value={cashAccountId}
                  onChange={(e) => setCashAccountId(e.target.value)}
                  disabled={!Number(cashOut)}>
                  <option value="">Choose…</option>
                  {(cashAccounts ?? []).map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </select>
              </div>
            </div>
            {cashOverpaid && (
              <div className="alert" style={{ marginTop: "0.5rem" }}>
                Amount paid can&rsquo;t be more than the invoice total ({fmt(total)} MMK).
              </div>
            )}
          </div>
        </div>
      )}

        <div className="card" style={{ marginTop: "0.5rem" }}>
          <div className="card-head">
            <h2>Additional information</h2>
          </div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="reference">Ref / order ID</label>
                <input id="reference" name="reference" type="text"
                       value={reference} onChange={(e) => setReference(e.target.value)}
                       placeholder={isSales ? "Sales order or customer PO" : "Purchase order or supplier invoice no"} />
                {initialGoodsReceiptId && reference && (
                  <span className="hint">
                    The order this {isSales ? "delivery" : "receipt"} came from. Type over it for the
                    {isSales ? " customer's" : " supplier's"} own number.
                  </span>
                )}
              </div>

              <div className="field">
                <label htmlFor="memo">Note</label>
                <textarea id="memo" name="memo" rows={2} placeholder="Optional — English or Myanmar" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="actions form-commit">
        <button type="submit"
          disabled={pending || total === 0 || shortages.length > 0 || cashOverpaid || (Number(cashOut) > 0 && !cashAccountId)}>
          {pending ? "Posting…" : `Post ${isSales ? "sales" : "purchase"} invoice`}
        </button>
        <span className="page-sub">
          Posting writes the stock movement and the journal entry together, or neither.
        </span>
      </div>
    </form>
  );
}
