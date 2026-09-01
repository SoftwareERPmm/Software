"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import type { ActionResult, PickerItem } from "@/lib/actions";
import { ItemPicker } from "./item-picker";

type Item = PickerItem;
type Node = { id: string; code: string; segment: string; name: string; parent_id: string | null };
type Uom = { id: string; code: string; name: string };
type Customer = {
  id: string; code: string; name: string;
  payment_terms_days: number; price_level_id: string | null;
};
type ItemPrice = { item_id: string; price_level_id: string; price: string };
type PriceLevel = { id: string; code: string; name: string; sort_order: number };
type Location = { id: string; code: string; name: string };
type StockRow = { item_id: string; location_id: string; qty_on_hand: string };
type Salesman = { id: string; code: string; name: string; name_my: string | null; commission_pct: string };
type CashAccount = { id: string; code: string; name: string };
type Promotion = {
  id: string; code: string; name: string;
  discount_pct: string; buy_qty: string | null; free_qty: string | null;
  item_id: string | null; item_group_id: string | null;
  item_code: string | null; group_name: string | null;
};
type FocReason = { id: string; code: string; name: string };
type OpenInvoice = {
  document_id: string; doc_no: string; partner_id: string;
  posting_date: string; due_date: string | null;
  gross_total: string; outstanding: string; aging_bucket: string;
};
type MatchLine = { itemId: string; itemCode: string; itemName: string; qty: number };
type OpenDelivery = { id: string; doc_no: string; doc_date: string; partner_id: string; location_id: string; lines: MatchLine[] };

type Line = { key: number; itemId: string; qty: string; unitPrice: string; discountPct: string };

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const day = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "—";

function addDays(iso: string, days: number) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function SalesVoucher({
  action, customers, items: initialItems, locations, salesmen, cashAccounts, promotions,
  focReasons, openInvoices, nextInvoiceNo, today, categories, uoms,
  itemPrices, priceLevels, stockByLocation, deliveries, initialDeliveryId,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  customers: Customer[];
  items: Item[];
  categories: Node[];
  uoms: Uom[];
  locations: Location[];
  stockByLocation: StockRow[];
  salesmen: Salesman[];
  cashAccounts: CashAccount[];
  promotions: Promotion[];
  focReasons: FocReason[];
  itemPrices: ItemPrice[];
  priceLevels: PriceLevel[];
  openInvoices: OpenInvoice[];
  nextInvoiceNo: string | null;
  today: string;
  /** Deliveries with no invoice against them yet, so a standalone delivery can be billed after the fact. */
  deliveries?: OpenDelivery[];
  /** Arrived via "Create sales invoice" on a specific delivery's own page — match it immediately. */
  initialDeliveryId?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null
  );

  // Items created mid-voucher join the list without a page reload.
  const [items, setItems] = useState<Item[]>(initialItems);
  const addItem = (i: Item) => setItems((xs) => [...xs, i]);

  const [lines, setLines] = useState<Line[]>([
    { key: 1, itemId: "", qty: "", unitPrice: "", discountPct: "" },
  ]);
  const [customerId, setCustomerId] = useState("");
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [matchedDeliveryId, setMatchedDeliveryId] = useState("");
  const [docDate, setDocDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [paymentType, setPaymentType] = useState<"CASH" | "CREDIT">("CREDIT");
  const [cashIn, setCashIn] = useState("");
  const [showRemark, setShowRemark] = useState(false);
  const [toDeliver, setToDeliver] = useState(false);
  const [fee, setFee] = useState("");
  const [tab, setTab] = useState<"invoices" | "promotions">("invoices");

  const byId = (id: string) => items.find((i) => i.id === id);

  // What's actually sitting at the selected location — the company-wide
  // on_hand on Item can show stock as available when the branch making this
  // sale has none of it, since the server checks availability per location
  // at posting time regardless of what this form suggests.
  const onHandByItem = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of stockByLocation) if (r.location_id === locationId) m.set(r.item_id, Number(r.qty_on_hand));
    return m;
  }, [stockByLocation, locationId]);
  const onHandHere = (itemId: string) => onHandByItem.get(itemId) ?? 0;

  const customer = customers.find((c) => c.id === customerId);
  const defaultLevelId = priceLevels[0]?.id ?? null;
  const activeLevelId = customer?.price_level_id ?? defaultLevelId;
  const activeLevel = priceLevels.find((l) => l.id === activeLevelId);

  /**
   * Master data supplies the suggestion; the line stores what was actually
   * charged. Changing the master price later must not restate old invoices,
   * which is why the price is copied onto the line rather than looked up.
   */
  function priceFor(itemId: string): number {
    const atLevel = itemPrices.find(
      (p) => p.item_id === itemId && p.price_level_id === activeLevelId
    );
    if (atLevel) return Number(atLevel.price);
    const anyLevel = itemPrices.find((p) => p.item_id === itemId);
    return anyLevel ? Number(anyLevel.price) : 0;
  }

  const setLine = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function pickItem(key: number, itemId: string) {
    const p = priceFor(itemId);
    setLine(key, { itemId, unitPrice: p > 0 ? String(p) : "" });
  }

  function pickCustomer(id: string) {
    setCustomerId(id);
    const c = customers.find((x) => x.id === id);
    if (!c) return;

    setDueDate(c.payment_terms_days > 0 ? addDays(docDate, c.payment_terms_days) : "");
    setPaymentType(c.payment_terms_days > 0 ? "CREDIT" : "CASH");

    // Re-quote lines already entered, since the level may differ. A price the
    // user typed over is left alone.
    const level = c.price_level_id ?? defaultLevelId;
    setLines((ls) =>
      ls.map((l) => {
        if (!l.itemId) return l;
        const wasSuggested = Number(l.unitPrice) === priceFor(l.itemId) || !l.unitPrice;
        if (!wasSuggested) return l;
        const at = itemPrices.find((p) => p.item_id === l.itemId && p.price_level_id === level);
        return { ...l, unitPrice: at ? String(Number(at.price)) : l.unitPrice };
      })
    );
  }

  const openDeliveries = (deliveries ?? []).filter((d) => d.partner_id === customerId);

  function matchDelivery(id: string) {
    setMatchedDeliveryId(id);
    const d = (deliveries ?? []).find((x) => x.id === id);
    if (!d) return;
    setCustomerId(d.partner_id);
    setLocationId(d.location_id);
    setToDeliver(false); // stock already left — "deliver later" no longer applies
    // Delivery lines carry no price — they moved stock at cost, not at what
    // the customer is charged — so this still looks the price up normally.
    setLines(
      d.lines.map((l, idx) => {
        const p = priceFor(l.itemId);
        return { key: idx + 1, itemId: l.itemId, qty: String(l.qty), unitPrice: p > 0 ? String(p) : "", discountPct: "" };
      })
    );
  }

  // Arrived from a specific delivery's own page — its customer isn't chosen
  // yet at this point, so this searches the full list rather than
  // openDeliveries (which only exists once a customer is picked).
  useEffect(() => {
    if (!initialDeliveryId) return;
    matchDelivery(initialDeliveryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDeliveryId]);

  const addLine = () =>
    setLines((ls) => [
      ...ls,
      { key: Math.max(0, ...ls.map((l) => l.key)) + 1, itemId: "", qty: "", unitPrice: "", discountPct: "" },
    ]);

  const removeLine = (key: number) =>
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((l) => l.key !== key)));

  const amount = (l: Line) => {
    const gross = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
    return gross - gross * ((Number(l.discountPct) || 0) / 100);
  };

  const promoReason = focReasons.find((r) => r.code === "PROMOTION");

  /** The buy-N-get-M promotion covering this item, if any. */
  function promoFor(itemId: string): Promotion | null {
    const item = byId(itemId);
    if (!item) return null;
    return (
      promotions.find(
        (p) =>
          Number(p.buy_qty) > 0 &&
          Number(p.free_qty) > 0 &&
          (p.item_id === itemId ||
            (p.item_group_id !== null && p.item_group_id === item.item_group_id) ||
            (p.item_id === null && p.item_group_id === null))
      ) ?? null
    );
  }

  /** Free units earned by a line. Whole multiples only — 25 of a buy-10-get-1 earns 2. */
  function freeQty(l: Line): number {
    const p = promoFor(l.itemId);
    if (!p || !promoReason) return 0;
    return Math.floor((Number(l.qty) || 0) / Number(p.buy_qty)) * Number(p.free_qty);
  }

  const goodsTotal = lines.reduce((s, l) => s + amount(l), 0);
  // Carriage charged to the customer. It is part of what they owe — so it
  // belongs in the total, the cash-in sync and the balance — but it is
  // credited to delivery income rather than to sales, which is why it is
  // shown separately rather than folded silently into the goods.
  const deliveryFee = Number(fee) || 0;
  const total = goodsTotal + deliveryFee;
  const cashAmount = Number(cashIn) || 0;
  const balance = total - cashAmount;
  const totalFree = lines.reduce((s, l) => s + freeQty(l), 0);

  // Cash means paid in full now — keep Cash in synced to the total so it
  // isn't a redundant retype of a number already on screen. Still a plain
  // input underneath, so it stays editable if the amount actually taken
  // differs (a customer paying in odd notes, say).
  useEffect(() => {
    if (paymentType === "CASH") setCashIn(String(total));
  }, [paymentType, total]);

  // Discount is netted into the unit price. Trade discount posts nothing of
  // its own — only settlement discount gets an account.
  //
  // Free units go on as separate zero-price lines carrying the promotion
  // reason, so their cost lands in promotion expense instead of COGS.
  const payload = JSON.stringify(
    lines
      .filter((l) => l.itemId && Number(l.qty) > 0)
      .flatMap((l) => {
        const qty = Number(l.qty);
        const paid = { itemId: l.itemId, qty, unitPrice: qty > 0 ? amount(l) / qty : 0 };
        const free = freeQty(l);
        return free > 0
          ? [paid, { itemId: l.itemId, qty: free, unitPrice: 0, focReasonId: promoReason!.id }]
          : [paid];
      })
  );

  // Availability must cover the free units too — they leave the warehouse.
  // Only matters when goods leave now; a deferred delivery doesn't touch
  // stock at invoice time, and a matched delivery already moved it, so
  // neither has anything left to check against.
  const shortages = toDeliver || matchedDeliveryId
    ? []
    : lines.filter((l) => {
        if (!l.itemId) return false;
        const item = byId(l.itemId);
        return item?.is_stocked && Number(l.qty) + freeQty(l) > onHandHere(l.itemId);
      });

  const customerInvoices = useMemo(
    () => openInvoices.filter((i) => i.partner_id === customerId),
    [openInvoices, customerId]
  );
  const customerOwes = customerInvoices.reduce((s, i) => s + Number(i.outstanding), 0);

  const cashTooMuch = cashAmount > total;

  return (
    <form action={formAction} className="form wide">
      {state && "error" in state && <div className="alert">{state.error}</div>}

      <input type="hidden" name="lines" value={payload} />
      <input type="hidden" name="payment_type" value={paymentType} />

      <div className="card">
        <div className="card-head">
          <h2>Voucher</h2>
          <span className="actions">
            <span className="pill">Sales invoice</span>
            {activeLevel && (
              <span className="pill ok" title="Prices suggested at this level">
                {activeLevel.name}
              </span>
            )}
            {nextInvoiceNo && (
              <span className="m" style={{ color: "var(--muted)" }}>No. {nextInvoiceNo}</span>
            )}
          </span>
        </div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="doc_date">Date</label>
              <input id="doc_date" name="doc_date" type="date" value={docDate}
                onChange={(e) => setDocDate(e.target.value)} required />
            </div>

            <div className="field">
              <label htmlFor="partner_id">Customer</label>
              <select id="partner_id" name="partner_id" value={customerId}
                onChange={(e) => pickCustomer(e.target.value)} required>
                <option value="">Choose…</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="salesman_id">Salesman</label>
              <select id="salesman_id" name="salesman_id" defaultValue="">
                <option value="">None</option>
                {salesmen.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {s.name}{Number(s.commission_pct) > 0 ? ` (${Number(s.commission_pct)}%)` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="location_id">Location</label>
              <select id="location_id" name="location_id" value={locationId}
                onChange={(e) => setLocationId(e.target.value)} required>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                ))}
              </select>
              <span className="hint">Stock leaves from here — On hand below is what&rsquo;s at this location</span>
            </div>

            <div className="field">
              <label htmlFor="reference">Ref / order ID</label>
              <input id="reference" name="reference" type="text" placeholder="Customer PO or phone order" />
              <span className="hint">Their number, not ours</span>
            </div>

            <div className="field">
              <label htmlFor="payment_select">Payment</label>
              <select id="payment_select" value={paymentType}
                onChange={(e) => setPaymentType(e.target.value as "CASH" | "CREDIT")}>
                <option value="CREDIT">Credit</option>
                <option value="CASH">Cash</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="due_date">Due date</label>
              <input id="due_date" name="due_date" type="date" value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                disabled={balance <= 0} required={balance > 0} />
              <span className="hint">
                {balance > 0 ? "From payment terms — required so this can be tracked as overdue" : "From payment terms"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {(deliveries?.length ?? 0) > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Matching</h2>
          </div>
          <div className="card-body">
            <div className="field">
              <label htmlFor="delivery_id">Match existing delivery</label>
              <select id="delivery_id" name="delivery_id" value={matchedDeliveryId}
                onChange={(e) => matchDelivery(e.target.value)} disabled={!customerId}>
                <option value="">
                  {customerId ? "Not matched — invoice fresh, or deliver later" : "Choose a customer first"}
                </option>
                {openDeliveries.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.doc_no} · {String(d.doc_date).slice(0, 10)} · {d.lines.length} line{d.lines.length === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
              <span className="hint">
                {matchedDeliveryId
                  ? "Lines are filled from this delivery, priced normally — stock already left, so Fulfilment below no longer applies."
                  : "Stock already left and just needs its invoice written — pick which delivery this is for."}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Items</h2>
          <button type="button" className="ghost tiny" onClick={addLine}>Add line</button>
        </div>
        <div className="tablewrap">
          <table className="linetable">
            <thead>
              <tr>
                <th>Item</th>
                <th className="r">On hand</th>
                <th className="r">Qty</th>
                <th className="r">Price</th>
                <th className="r">Disc %</th>
                <th className="r">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.flatMap((l) => {
                const item = byId(l.itemId);
                const free = freeQty(l);
                const short = !toDeliver && !matchedDeliveryId && item?.is_stocked && Number(l.qty) + free > onHandHere(l.itemId);
                const promo = promoFor(l.itemId);

                const freeRow =
                  free > 0 && item ? (
                    <tr key={`${l.key}-free`}>
                      <td style={{ paddingLeft: "1.6rem" }}>
                        <span style={{ color: "var(--ghost)" }}>└ </span>
                        <span className="m">{item.code}</span>{" "}
                        <span className="pill warn">{promo!.code}</span>
                      </td>
                      <td className="r" style={{ color: "var(--muted)" }}>free</td>
                      <td className="r">{fmt(free)}</td>
                      <td className="r" style={{ color: "var(--muted)" }}>0</td>
                      <td />
                      <td className="r" style={{ color: "var(--muted)" }}>0</td>
                      <td />
                    </tr>
                  ) : null;

                return [
                  <tr key={l.key}>
                    <td style={{ minWidth: 240 }}>
                      <ItemPicker
                        mode="sales"
                        items={items}
                        categories={categories}
                        uoms={uoms}
                        value={l.itemId}
                        onPick={(id) => pickItem(l.key, id)}
                        onCreated={addItem}
                      />
                    </td>
                    <td className="r" style={{ color: short ? "var(--bad)" : undefined }}>
                      {!item ? "—" : item.is_stocked ? (
                        <>
                          {fmt(onHandHere(item.id))}
                          <div style={{ fontSize: "0.72rem", fontWeight: 400, color: "var(--muted)" }}>
                            {fmt(Number(item.on_hand))} total
                          </div>
                        </>
                      ) : "service"}
                    </td>
                    <td className="narrow">
                      <input type="number" min="0" step="any" value={l.qty} aria-label="Quantity"
                        onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                    </td>
                    <td className="narrow">
                      <input type="number" min="0" step="any" value={l.unitPrice} aria-label="Unit price"
                        onChange={(e) => setLine(l.key, { unitPrice: e.target.value })} />
                    </td>
                    <td className="tight">
                      <input type="number" min="0" max="100" step="any" value={l.discountPct} aria-label="Discount percent"
                        onChange={(e) => setLine(l.key, { discountPct: e.target.value })} />
                    </td>
                    <td className="r">{fmt(amount(l))}</td>
                    <td className="tight">
                      <button type="button" className="ghost tiny" aria-label="Remove line"
                        onClick={() => removeLine(l.key)} disabled={lines.length === 1}>×</button>
                    </td>
                  </tr>,
                  freeRow,
                ];
              })}
            </tbody>
          </table>
        </div>
        <div className="totalbar">
          {totalFree > 0 && (
            <span style={{ color: "var(--muted)" }}>
              {fmt(totalFree)} free unit{totalFree === 1 ? "" : "s"} — cost goes to promotion expense
            </span>
          )}
          {deliveryFee > 0 && (
            <span style={{ color: "var(--muted)" }}>
              goods {fmt(goodsTotal)} + delivery {fmt(deliveryFee)}
            </span>
          )}
          <span style={{ color: "var(--muted)" }}>Invoice total</span>
          <span className="big">{fmt(total)} MMK</span>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="card-head"><h2>Payment &amp; delivery</h2></div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="delivery_fee">Delivery fee</label>
                <input id="delivery_fee" name="delivery_fee" type="number" min="0" step="0.01"
                  value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" />
                <span className="hint">
                  Charged for carrying the goods. Credited to delivery income, not
                  sales, so margin on the products stays honest.
                </span>
              </div>
              <div className="field">
                <label htmlFor="cash_in">Cash in</label>
                <input id="cash_in" name="cash_in" type="number" min="0" step="any"
                  value={cashIn} onChange={(e) => setCashIn(e.target.value)} />
                <span className="hint">Taken now — creates a receipt against this invoice</span>
              </div>
              <div className="field">
                <label htmlFor="cash_account_id">Into account</label>
                <select id="cash_account_id" name="cash_account_id"
                  defaultValue={cashAccounts[0]?.id ?? ""} disabled={cashAmount <= 0}>
                  {cashAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {matchedDeliveryId ? (
              <div style={{ marginTop: "1rem" }}>
                <label style={{ display: "block", marginBottom: "0.5rem" }}>Fulfilment</label>
                <span className="hint">Stock already left with this delivery — this invoice only records revenue.</span>
              </div>
            ) : (
              <div style={{ marginTop: "1rem" }}>
                <label style={{ display: "block", marginBottom: "0.5rem" }}>Fulfilment</label>
                <div className="row">
                  <label className="check" style={{ alignItems: "flex-start" }}>
                    <input type="radio" name="fulfilment" checked={!toDeliver}
                      onChange={() => setToDeliver(false)} style={{ marginTop: "0.2rem" }} />
                    <span>
                      <div>Take now</div>
                      <span className="hint">Goods leave immediately — delivery and invoice post together</span>
                    </span>
                  </label>
                  <label className="check" style={{ alignItems: "flex-start" }}>
                    <input type="radio" name="fulfilment" checked={toDeliver}
                      onChange={() => setToDeliver(true)} style={{ marginTop: "0.2rem" }} />
                    <span>
                      <div>Deliver later</div>
                      <span className="hint">
                        Revenue posts now; stock leaves later from Sales → Deliveries
                      </span>
                    </span>
                  </label>
                </div>
                {toDeliver && <input type="hidden" name="to_deliver" value="on" />}
                {openDeliveries.length > 0 && (
                  <div className="alert" style={{ marginTop: "0.75rem" }}>
                    {customer?.name ?? "This customer"} already ha{openDeliveries.length === 1 ? "s" : "ve"}{" "}
                    {openDeliveries.length} deliver{openDeliveries.length === 1 ? "y" : "ies"} waiting for an
                    invoice. If this sale is for stock that already left, match it above instead —
                    otherwise {toDeliver ? "this creates yet another one waiting" : "the same stock leaves twice"}.
                  </div>
                )}
              </div>
            )}

            <div className="totalbar" style={{ marginTop: "0.5rem", paddingRight: 0 }}>
              <span style={{ color: "var(--muted)" }}>Balance on account</span>
              <span className="big" style={{ color: balance > 0 ? "var(--cr)" : "var(--ok)" }}>
                {fmt(balance)}
              </span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Voucher information</h2>
            <span className="actions">
              <button type="button" className={tab === "invoices" ? "tiny" : "ghost tiny"}
                onClick={() => setTab("invoices")}>Invoices</button>
              <button type="button" className={tab === "promotions" ? "tiny" : "ghost tiny"}
                onClick={() => setTab("promotions")}>Promotions</button>
            </span>
          </div>

          {tab === "invoices" ? (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Invoice</th><th>Due</th><th className="r">Outstanding</th><th>Age</th></tr>
                </thead>
                <tbody>
                  {customerInvoices.map((i) => (
                    <tr key={i.document_id}>
                      <td className="code">{i.doc_no}</td>
                      <td className="code">{day(i.due_date)}</td>
                      <td className="r">{fmt(Number(i.outstanding))}</td>
                      <td>
                        <span className={`pill ${i.aging_bucket === "CURRENT" ? "ok" : "overdue"}`}>
                          {i.aging_bucket === "CURRENT" ? "Current" : i.aging_bucket}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {customerInvoices.length === 0 && (
                    <tr><td colSpan={4} className="empty">
                      {customerId ? "Nothing outstanding for this customer" : "Choose a customer"}
                    </td></tr>
                  )}
                </tbody>
                {customerInvoices.length > 0 && (
                  <tfoot>
                    <tr><td colSpan={2}>Already owes</td><td className="r">{fmt(customerOwes)}</td><td /></tr>
                  </tfoot>
                )}
              </table>
            </div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Code</th><th>Promotion</th><th>Applies to</th><th className="r">Benefit</th></tr>
                </thead>
                <tbody>
                  {promotions.map((p) => (
                    <tr key={p.id}>
                      <td className="code">{p.code}</td>
                      <td className="wrap">{p.name}</td>
                      <td>{p.item_code ?? p.group_name ?? "All items"}</td>
                      <td className="r">
                        {Number(p.discount_pct) > 0
                          ? `${Number(p.discount_pct)}%`
                          : `${Number(p.buy_qty)}+${Number(p.free_qty)}`}
                      </td>
                    </tr>
                  ))}
                  {promotions.length === 0 && (
                    <tr><td colSpan={4} className="empty">No active promotions</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {shortages.length > 0 && (
        <div className="alert">
          Not enough stock for {shortages.map((l) => byId(l.itemId)?.code).join(", ")}.
          Reduce the quantity or receive stock first.
        </div>
      )}

      {cashTooMuch && (
        <div className="alert">Cash in is more than the invoice total.</div>
      )}

      {showRemark ? (
        <div className="field">
          <label htmlFor="memo">Remark</label>
          <textarea id="memo" name="memo" rows={2} autoFocus placeholder="Note for this voucher — English or Myanmar" />
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="ghost" onClick={() => setShowRemark(true)}>
            Add remark
          </button>
        </div>
      )}

      <div className="actions">
        <button type="submit"
          disabled={pending || total === 0 || shortages.length > 0 || cashTooMuch}>
          {pending ? "Posting…" : "Post voucher"}
        </button>
        <span className="page-sub">
          Stock, the receivable{cashAmount > 0 ? ", the receipt" : ""} and the journal entry are
          written together, or none of them are.
        </span>
      </div>
    </form>
  );
}
