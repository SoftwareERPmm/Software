"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import type { ActionResult, PickerItem } from "@/lib/actions";
import { NegativeStockConfirm, type Shortfall } from "./negative-stock-confirm";
import { StockSourceDialog, poolsFor, type OwnershipSplit } from "./stock-source";
import { priceLines, type VolumeBand } from "@/lib/discount";
import { ItemPicker } from "./item-picker";
import { PartnerPicker } from "./partner-picker";
import Link from "next/link";
import { AwaitingOrders, AlreadyAwaited } from "./awaiting-orders";
import { useBackHere } from "./back-here";
import { PackageCheck, Truck, Clock, ShoppingBag, Check } from "lucide-react";
import type { AwaitingLine } from "@/lib/queries";

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
type MatchLine = {
  /** The delivery line itself, so an invoice can say which line it bills. */
  lineId: string;
  itemId: string; itemCode: string; itemName: string; qty: number;
  /** What the sales order agreed, where the delivery came out of one. */
  orderPrice?: number | null;
  orderId?: string | null;
  orderNo?: string | null;
};
type OpenDelivery = {
  id: string; doc_no: string; doc_date: string; partner_id: string; location_id: string;
  /** The sales order this delivery was raised from, when it came from one. */
  source_no?: string | null;
  lines: MatchLine[];
};

type Line = {
  key: number; itemId: string; qty: string; unitPrice: string; discountPct: string;
  /** Which unit the quantity and the price are in. Empty means the item's
   *  own unit, which is every line for an item with no packs. */
  uomId?: string;
  /**
   * The delivery line this one bills, when the invoice was raised from a
   * delivery. Recorded so the quantity can be held to what actually went out
   * — and so the engine can refuse an invoice for more than that.
   */
  sourceLineId?: string;
  /** What that delivery line still has unbilled — the ceiling on this line. */
  sourceQty?: string;
  /**
   * The order line this one bills, when the voucher was filled from an open
   * sales order. Separate from sourceLineId, which means "prefilled from a
   * delivery" and holds the quantity to what went out.
   */
  orderLineId?: string;
  /** The order's agreed price, when there is an order behind this line. */
  agreedPrice?: number | null;
  orderId?: string | null;
  orderNo?: string | null;
  /** Given away on this line, on top of anything a promotion earns. */
  focQty: string;
  /** Why they are free — promotion, sample, office use, damaged. Blank
   *  defaults to the promotional reason. */
  focReasonId: string;
  /** "OWNED" or a consignor's id. Only reaches the ledger when the goods
   *  actually leave — on a Take Now invoice, which creates the delivery. */
  source: string;
};

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
  volumeDiscounts,
  currencyScale = 4,
  focReasons, openInvoices, nextInvoiceNo, today, categories, uoms,
  itemPrices, priceLevels, stockByLocation, deliveries, initialDeliveryId,
  taxCodes = [],
  customerCredit = [],
  ownership = [],
  awaiting = [],
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
  /** Decimal places this company's money has — 0 for the kyat. */
  currencyScale?: number;
  /** Quantity and invoice-total discount bands, for previewing what the
   *  engine will apply. */
  volumeDiscounts?: VolumeBand[];
  focReasons: FocReason[];
  /** What each customer with a limit may owe, and what they already do. */
  customerCredit?: {
    partner_id: string; credit_limit: string | number;
    outstanding: string | number; unbilled_deliveries: string | number;
    exposure: string | number; available: string | number;
  }[];
  /** Commercial tax codes this company can charge, zero-rate first. */
  taxCodes?: {
    id: string; code: string; name: string;
    /** Every rate this code has carried, oldest first. */
    rates: { rate: string | number; validFrom: string }[];
  }[];
  itemPrices: ItemPrice[];
  priceLevels: PriceLevel[];
  openInvoices: OpenInvoice[];
  nextInvoiceNo: string | null;
  today: string;
  /** Deliveries with no invoice against them yet, so a standalone delivery can be billed after the fact. */
  deliveries?: OpenDelivery[];
  /** Arrived via "Create sales invoice" on a specific delivery's own page — match it immediately. */
  initialDeliveryId?: string;
  /** Orders to this customer with goods still owed. See getOpenOrdersAwaitingGoods. */
  awaiting?: AwaitingLine[];
  /** Consigned stock on hand, per item, warehouse and consignor. Owned and
   *  consigned goods share a shelf and nothing about the shelf says which
   *  is which, so the line has to be told. */
  ownership?: {
    item_id: string; location_id: string; consignor_id: string;
    consignor_code: string; consignor_name: string; qty: string;
  }[];
}) {
  const backHere = useBackHere();
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null
  );

  /** See the hidden field below. */
  const [attemptKey] = useState(() => crypto.randomUUID());

  // Items created mid-voucher join the list without a page reload.
  const [items, setItems] = useState<Item[]>(initialItems);
  const addItem = (i: Item) => setItems((xs) => [...xs, i]);

  const [lines, setLines] = useState<Line[]>([
    { key: 1, itemId: "", qty: "", unitPrice: "", discountPct: "", focQty: "", focReasonId: "", source: "OWNED" },
  ]);
  const [customerId, setCustomerId] = useState("");
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [matchedDeliveryId, setMatchedDeliveryId] = useState("");
  /**
   * Bill less than went out — asked for, not typed into. The purchase side's
   * rule, on this side for the same reason: an invoice for 90 typed over a
   * delivery of 100 is indistinguishable from a slip, while billing half a
   * shipment now and half next month is an ordinary thing to want. Ticking
   * this opens the quantities and caps each at what that delivery line still
   * has unbilled.
   */
  const [billPart, setBillPart] = useState(false);
  const [reference, setReference] = useState("");
  /** Which open order this invoice was filled from, if any. */
  const [fromOrderId, setFromOrderId] = useState<string | null>(null);
  // Set only by answering the dialog. It rides along as a hidden field, so
  // the posting engine is told a person confirmed rather than inferring it
  // from the fact that stock happened to be short.
  const [negativeConfirmed, setNegativeConfirmed] = useState(false);
  const [askNegative, setAskNegative] = useState(false);
  const [docDate, setDocDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [paymentType, setPaymentType] = useState<"CASH" | "CREDIT">("CREDIT");
  const [cashIn, setCashIn] = useState("");
  const [toDeliver, setToDeliver] = useState(false);
  /**
   * Whether the goods have gone, are going, or go later.
   *
   * The same question the purchase invoice asks about a goods receipt, and it
   * was asked the same way it used to be there: a "Match delivery" select in
   * the header row and two radios at the foot of the payment card, a card
   * apart from each other, both below the lines. It decides whether posting
   * moves stock — the most consequential thing on the screen — and it read
   * like a preference.
   *
   * matchedDeliveryId and toDeliver still carry it to the server; this only
   * decides which of them the screen is setting, so the three states cannot
   * contradict each other the way two independent controls could.
   */
  const [fulfilMode, setFulfilMode] = useState<"counter" | "send" | "later" | "match">("counter");
  const [sourceFor, setSourceFor] = useState<number | null>(null);
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

  /** The order these prices were agreed on, when one is behind them. */
  const agreedFrom = lines.find((l) => l.agreedPrice != null && l.orderId)
    ?? null;

  const setLine = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function pickItem(key: number, itemId: string) {
    const p = priceFor(itemId);
    setLine(key, { itemId, unitPrice: p > 0 ? String(p) : "" });
  }

  function pickCustomer(id: string) {
    setCustomerId(id);
    setFromOrderId(null);
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

  /**
   * Sales orders from this customer still owed goods. Suppressed once a
   * delivery is matched: that invoice bills goods that have already gone
   * out, which is the correct path and not the mistake this warns about.
   */
  const awaited = !customerId || matchedDeliveryId
    ? []
    : (awaiting ?? []).filter((a) => a.partner_id === customerId);

  /**
   * Our own number for the job this invoice belongs to — the sales order it
   * traces back to, or the delivery itself when it was raised without one.
   *
   * Filled in rather than left blank because stepping order → delivery →
   * invoice already knows the answer, and making someone copy it across from
   * another screen is how an invoice ends up with no order on it at all. It
   * stays an ordinary input: a customer's own PO can be typed over it.
   */
  const referenceFor = (d: OpenDelivery) => d.source_no || d.doc_no;

  function chooseFulfilMode(mode: "counter" | "send" | "later" | "match") {
    setFulfilMode(mode);
    // A transport charge only means something where somebody carried the
    // goods. Cleared rather than hidden-and-kept, so what is on screen is
    // what posts.
    if (mode === "counter" || mode === "match") setFee("");
    if (mode === "match") { setToDeliver(false); return; }
    // Leaving "already gone" drops the delivery it was matched to, and the
    // lines that came from it — they were that delivery's, not this sale's.
    if (matchedDeliveryId) {
      setMatchedDeliveryId("");
      setLines([{ key: 1, itemId: "", qty: "", unitPrice: "", discountPct: "",
                  focQty: "", focReasonId: "", source: "OWNED" }]);
    }
    setToDeliver(mode === "later");
  }

  function matchDelivery(id: string) {
    setFromOrderId(null);
    setMatchedDeliveryId(id);
    setBillPart(false);
    const d = (deliveries ?? []).find((x) => x.id === id);
    if (!d) return;
    setCustomerId(d.partner_id);
    setLocationId(d.location_id);
    setToDeliver(false); // stock already left — "deliver later" no longer applies
    setFulfilMode("match");
    // A delivery moves stock at cost and carries no selling price of its own,
    // so the price comes from somewhere else. Where the delivery came out of
    // an order, that somewhere is the order: what was agreed is what is
    // billed, and it is held rather than offered — changing it is correcting
    // the agreement, which is done at the order and carries into the bill.
    // With no order behind it, nothing was agreed and the price list is the
    // right answer.
    setLines(
      d.lines.map((l, idx) => {
        const agreed = l.orderPrice ?? null;
        const p = agreed ?? priceFor(l.itemId);
        return { key: idx + 1, itemId: l.itemId, qty: String(l.qty), unitPrice: p > 0 ? String(p) : "",
                 discountPct: "", focQty: "", focReasonId: "", source: "OWNED",
                 sourceLineId: l.lineId, sourceQty: String(l.qty),
                 agreedPrice: agreed, orderId: l.orderId ?? null, orderNo: l.orderNo ?? null };
      })
    );
  }

  // Arrived from a specific delivery's own page — its customer isn't chosen
  // yet at this point, so this searches the full list rather than
  // openDeliveries (which only exists once a customer is picked).
  useEffect(() => {
    if (!initialDeliveryId) return;
    matchDelivery(initialDeliveryId);
    // Only when the invoice was opened from a document — walking the chain is
    // what makes the order relevant. Someone who opened a blank invoice and
    // chose a delivery from the list is composing it themselves, and having a
    // number appear under their hands is noise rather than help.
    const d = (deliveries ?? []).find((x) => x.id === initialDeliveryId);
    if (d) setReference(referenceFor(d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDeliveryId]);

  /**
   * Fill this invoice from an open sales order: what is still owed on it, at
   * the price agreed there. The order number goes in the reference field, the
   * same place a delivery's does — an invoice names a delivery as its source
   * and never an order, so the chain closes when the goods go out.
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
      discountPct: "",
      focQty: "",
      focReasonId: "",
      source: "OWNED" as const,
      agreedPrice: r.unit_price,
      orderLineId: r.order_line_id,
      orderId: r.order_id,
      orderNo: r.doc_no,
      // What the order still has to be invoiced — the ceiling on this line.
      sourceQty: String(r.outstanding),
    })));
    setReference(rows[0].doc_no);
  }

  function billWholeDelivery(part: boolean) {
    setBillPart(part);
    if (!part) {
      setLines((ls) => ls.map((l) => (l.sourceQty ? { ...l, qty: l.sourceQty } : l)));
    }
  }

  const addLine = () =>
    setLines((ls) => [
      ...ls,
      { key: Math.max(0, ...ls.map((l) => l.key)) + 1, itemId: "", qty: "", unitPrice: "",
        discountPct: "", focQty: "", focReasonId: "", source: "OWNED" },
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

  /** Free units earned by a promotion. Whole multiples only — 25 of a
   *  buy-10-get-1 earns 2. */
  function earnedFree(l: Line): number {
    const p = promoFor(l.itemId);
    if (!p || !promoReason) return 0;
    return Math.floor((Number(l.qty) || 0) / Number(p.buy_qty)) * Number(p.free_qty);
  }

  /** Typed on the line: a giveaway the seller decided on, for whatever
   *  reason they pick. Independent of any promotion. */
  const givenFree = (l: Line) => Math.max(0, Number(l.focQty) || 0);

  // A free quantity with no reason has nowhere to put its cost, so the first
  // reason stands in until one is chosen rather than leaving the select blank.
  useEffect(() => {
    const fallback = promoReason?.id ?? focReasons[0]?.id;
    if (!fallback) return;
    setLines((ls) =>
      ls.some((l) => Number(l.focQty) > 0 && !l.focReasonId)
        ? ls.map((l) => (Number(l.focQty) > 0 && !l.focReasonId ? { ...l, focReasonId: fallback } : l))
        : ls
    );
  }, [lines, promoReason, focReasons]);

  /** Everything leaving the warehouse free on this line. Both kinds count
   *  against stock — a free unit is still a unit off the shelf. */
  const freeQty = (l: Line) => earnedFree(l) + givenFree(l);

  // The same function the posting engine runs, so the figure previewed is the
  // figure posted. Two implementations of "which band applies" is exactly how
  // a voucher comes to show one total and post another.
  /* How many base units one entered unit is, for a line naming a pack. The
     same figure the engine resolves, read off the item the picker already
     carries — so the preview cannot price on one factor while the posting
     uses another. */
  const factorOf = (l: Line) => {
    if (!l.uomId) return 1;
    const p = (byId(l.itemId)?.packs ?? []).find((x) => x.uomId === l.uomId);
    return p ? Number(p.factor) || 1 : 1;
  };
  /** The quantity in the item's own unit — what stock and bands are about. */
  const baseQtyOf = (l: Line) => (Number(l.qty) || 0) * factorOf(l);

  const chargedLines = lines.filter((l) => l.itemId && Number(l.qty) > 0);
  const pricing = priceLines(
    chargedLines.map((l) => ({
      itemId: l.itemId,
      itemGroupId: byId(l.itemId)?.item_group_id ?? null,
      qty: Number(l.qty) || 0,
      // A quantity band counts stock, not packaging: five cartons of
      // twenty-four earns a hundred-unit band and five pieces does not.
      baseQty: baseQtyOf(l),
      unitPrice: Number(l.unitPrice) || 0,
      discountPct: Number(l.discountPct) || 0,
    })),
    volumeDiscounts ?? [],
    // Rounded the same way the posting will round it. Previewing at four
    // decimal places and posting at whole kyat is how a voucher comes to show
    // one total and post another by half a unit.
    currencyScale,
  );
  const pricedFor = new Map(chargedLines.map((l, i) => [l.key, pricing.lines[i]]));

  const goodsTotal = pricing.total;

  /* Commercial tax. One code for the whole invoice rather than per line:
     that is how a Myanmar trader charges it, and a per-line override can
     come later without changing what is stored — the engine already keeps
     the code on each line. */
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

  // The same split the engine does, so the voucher cannot preview one figure
  // and post another: exclusive adds on top, inclusive comes back out.
  const r = (n: number) => {
    const f = Math.pow(10, currencyScale);
    return Math.round(n * f) / f;
  };
  const taxOnGoods = taxRate === 0 ? 0
    : inclusive ? r(goodsTotal - r(goodsTotal / (1 + taxRate / 100)))
    : r((goodsTotal * taxRate) / 100);
  const goodsNet = inclusive ? r(goodsTotal - taxOnGoods) : goodsTotal;
  // Carriage charged to the customer. It is part of what they owe — so it
  // belongs in the total, the cash-in sync and the balance — but it is
  // credited to delivery income rather than to sales, which is why it is
  // shown separately rather than folded silently into the goods.
  const deliveryFee = Number(fee) || 0;
  // What the customer owes: the goods net of tax, the tax, and the carriage.
  // Carriage is outside the tax for now — it is income earned for
  // delivering, and taxing it needs its own code on the header.
  const total = r(goodsNet + taxOnGoods + deliveryFee);
  const cashAmount = Number(cashIn) || 0;
  const balance = total - cashAmount;

  /* What this customer may owe, and what this sale would add to it. Only the
     part left owing counts: cash at the counter extends no credit, which is
     why a customer already over their limit can still buy for cash. */
  const [overLimitOk, setOverLimitOk] = useState(false);
  const [overLimitWhy, setOverLimitWhy] = useState("");
  const standing = customerCredit.find((c) => c.partner_id === customerId) ?? null;
  const creditLimit = standing ? Number(standing.credit_limit) : null;
  const exposure = standing ? Number(standing.exposure) : 0;
  const onAccount = Math.max(0, total - cashAmount);
  const wouldOwe = exposure + onAccount;
  const overLimit = creditLimit !== null && onAccount > 0 && wouldOwe > creditLimit;
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
  const splitFor = (itemId: string): OwnershipSplit => ({
    owned: onHandHere(itemId),
    consigned: (ownership ?? [])
      .filter((o) => o.item_id === itemId && o.location_id === locationId)
      .map((o) => ({
        consignorId: o.consignor_id, code: o.consignor_code,
        name: o.consignor_name, qty: Number(o.qty),
      })),
  });
  const anyConsigned = (ownership ?? []).some((o) => o.location_id === locationId);

  const payload = JSON.stringify(
    lines
      .filter((l) => l.itemId && Number(l.qty) > 0)
      .flatMap((l) => {
        const qty = Number(l.qty);
        // The list price and the discount typed against it, rather than one
        // netted figure — the engine applies the bands and records which part
        // of the reduction came from where.
        // Whose goods. Only meaningful when this invoice takes the stock now
        // — a deliver-later invoice moves nothing, and the delivery raised
        // against it later is where the pool is chosen.
        const pool = toDeliver
          ? {}
          : {
              source: l.source === "OWNED" ? "OWNED" : "CONSIGNMENT",
              consignorId: l.source === "OWNED" ? null : l.source,
            };
        const paid = {
          itemId: l.itemId, qty,
          // Whatever unit the line names. A free carton is a carton, so the
          // giveaway lines below carry it too.
          uomId: l.uomId || null,
          unitPrice: Number(l.unitPrice) || 0,
          discountPct: Number(l.discountPct) || 0,
          taxCodeId: taxCodeId || null,
          // Which delivery line this bills, so the engine can hold it to what
          // went out. Free lines carry no source: a giveaway is not part of
          // what the delivery is owed billing for.
          // Whichever this line came from — a delivery line, or the order
          // line the voucher was filled from. Never both.
          ...(l.sourceLineId || l.orderLineId
            ? { sourceLineId: l.sourceLineId ?? l.orderLineId }
            : {}),
          ...pool,
        };
        // Kept as two lines when both apply, because they are two different
        // events with two different reasons — a promotion the customer
        // triggered, and a giveaway someone decided on. Merging them would
        // put the whole cost against one reason and lose the other.
        const earned = earnedFree(l);
        const given = givenFree(l);
        const out: unknown[] = [paid];
        if (earned > 0 && promoReason) {
          out.push({ itemId: l.itemId, qty: earned, unitPrice: 0,
                     uomId: l.uomId || null,
                     focReasonId: promoReason.id, ...pool });
        }
        if (given > 0) {
          const reason = l.focReasonId || promoReason?.id;
          if (reason) out.push({ itemId: l.itemId, qty: given, unitPrice: 0,
                                 uomId: l.uomId || null,
                                 focReasonId: reason, ...pool });
        }
        return out;
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
        // Compared in the item's own unit: five cartons is a hundred and
        // twenty pieces off the shelf, and comparing five against the stock
        // figure would call a short line comfortable.
        return item?.is_stocked
          && (Number(l.qty) + freeQty(l)) * factorOf(l) > onHandHere(l.itemId);
      });

  /** What the dialog states, per item, in the words someone can actually
   *  confirm: this many needed, this many recorded, this many after. */
  const shortfalls: Shortfall[] = shortages.map((l) => {
    const item = byId(l.itemId);
    return {
      itemCode: item?.code ?? "",
      itemName: item?.name ?? "",
      uomCode: item?.uom_code ?? "",
      required: (Number(l.qty) + freeQty(l)) * factorOf(l),
      recorded: onHandHere(l.itemId),
    };
  });

  // Answering yes and then editing the lines must not carry the old answer
  // forward — the figures it was given no longer describe what is about to
  // post. Cleared whenever the shortage picture changes.
  const shortfallKey = shortfalls
    .map((s) => `${s.itemCode}:${s.required}:${s.recorded}`).join("|");
  useEffect(() => {
    setNegativeConfirmed(false);
  }, [shortfallKey]);

  const customerInvoices = useMemo(
    () => openInvoices.filter((i) => i.partner_id === customerId),
    [openInvoices, customerId]
  );
  const customerOwes = customerInvoices.reduce((s, i) => s + Number(i.outstanding), 0);

  const cashTooMuch = cashAmount > total;

  return (
    <form action={formAction} className="form wide">
      {/* One submission, one posting. Generated when this form mounts, so a
          double-click or a resent request carries the same key and is handed
          the document the first one posted; a new form is a new key. */}
      <input type="hidden" name="idempotency_key" value={attemptKey} />

      {state && "error" in state && <div className="alert">{state.error}</div>}

      <input type="hidden" name="lines" value={payload} />
      <input type="hidden" name="payment_type" value={paymentType} />

      <div className="card doc-meta">
        <div className="card-head">
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
              <PartnerPicker
                partners={customers as never}
                value={customerId}
                onPick={pickCustomer}
              />
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
              <span className="hint">Stock leaves from here</span>
            </div>

            <div className="field">
              <label htmlFor="reference">Ref / order ID</label>
              <input id="reference" name="reference" type="text"
                     value={reference} onChange={(e) => setReference(e.target.value)}
                     placeholder="Sales order, customer PO or phone order" />
              {initialDeliveryId && reference && (
                <span className="hint">
                  The order this delivery came from. Type over it for a customer&rsquo;s own PO.
                </span>
              )}
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

      {/* An open order this invoice may belong to. Billing here sends goods of
          its own, so the same order can ship twice — once from the voucher and
          once when somebody delivers against the order it was raised for. */}
      <AwaitingOrders
        lines={awaited}
        sales
        purpose="bill"
        backTo="/sales/new"
        onUse={fillFromOrder}
        usedOrderId={fromOrderId}
      />

      {/* Above the lines, because the situation is decided before the items
          are typed — and worded as the situation rather than the mechanism.
          Somebody billing a sale knows whether the goods have gone; they do
          not necessarily know what a delivery document is. */}
      <div className="card receive-mode">
        <div className="card-head">
          <h2>Fulfilment</h2>
          <span className="page-sub">Choose how the goods leave your business.</span>
        </div>
        <div className="card-body">
          <div className="modes" role="radiogroup" aria-label="Delivery status">
            {([
              {
                key: "counter" as const,
                icon: <ShoppingBag size={18} aria-hidden="true" />,
                title: "Customer takes now",
                lead: "Counter sale or pickup. Goods leave immediately.",
                // Not "no delivery document" — one is always written for
                // stocked goods, because it is what records the stock leaving
                // and draws the cost. What is true is that nobody has to make
                // it, and somebody who read that there was none would go
                // looking for the SI… number and not understand it.
                note: "No delivery step, and no transport charge",
                disabled: false,
              },
              {
                key: "send" as const,
                icon: <Truck size={18} aria-hidden="true" />,
                title: "We deliver now",
                lead: "Goods leave now, carried to the customer.",
                note: "A delivery is recorded, and you can charge for it",
                disabled: false,
              },
              {
                key: "later" as const,
                icon: <Clock size={18} aria-hidden="true" />,
                title: "Deliver later",
                lead: "Invoice now, deliver later.",
                note: "Stock leaves when you create the delivery",
                disabled: false,
              },
              {
                key: "match" as const,
                icon: <PackageCheck size={18} aria-hidden="true" />,
                title: "Already delivered",
                lead: "Bill a delivery that has already gone out.",
                note: customerId
                  ? openDeliveries.length > 0
                    ? `${openDeliveries.length} deliver${openDeliveries.length === 1 ? "y" : "ies"} waiting on an invoice`
                    : "Nothing for this customer is waiting on an invoice"
                  : "Choose a customer first",
                disabled: !customerId || openDeliveries.length === 0,
              },
            ]).map((m) => (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={fulfilMode === m.key}
                className={`mode${fulfilMode === m.key ? " on" : ""}`}
                disabled={m.disabled}
                onClick={() => chooseFulfilMode(m.key)}
              >
                <span className="mode-icon">{m.icon}</span>
                <span className="mode-text">
                  <strong>{m.title}</strong>
                  <span className="mode-lead">{m.lead}</span>
                  <span className="mode-note">{m.note}</span>
                </span>
              </button>
            ))}
          </div>

          {/* What the choice just made will do, in the three terms somebody
              posting cares about: the stock, the paperwork, and the money.
              It restates the card deliberately — this is the one decision on
              the screen that cannot be undone by editing, and a line that
              confirms it after the click is read where a card read before it
              was chosen is not. */}
          <div className="fulfil-says">
            <Check size={15} aria-hidden="true" />
            <div>
              <strong>
                {fulfilMode === "counter" ? "Customer takes now"
                  : fulfilMode === "send" ? "We deliver now"
                  : fulfilMode === "later" ? "Deliver later"
                  : "Already delivered"} selected
              </strong>
              <ul>
                <li>
                  {fulfilMode === "later"
                    ? "Stock stays where it is until you create the delivery."
                    : fulfilMode === "match"
                      ? "Stock already left with that delivery — nothing moves again."
                      : "Stock leaves as soon as this invoice posts."}
                </li>
                <li>
                  {fulfilMode === "match"
                    ? "The delivery's own transport charge is billed here."
                    : fulfilMode === "counter"
                      ? "No transport charge — nobody carried the goods."
                      : "A transport charge can be added below."}
                </li>
                <li>
                  {fulfilMode === "later"
                    ? "Revenue and the receivable post now."
                    : fulfilMode === "match"
                      ? "Revenue posts now; the cost was taken by the delivery."
                      : "A delivery is recorded for you — no separate step."}
                </li>
              </ul>
            </div>
          </div>

          {/* Under the choice it belongs to. In the header row it was a field
              somebody scrolled past on the way to the lines. */}
          {fulfilMode === "match" && (deliveries?.length ?? 0) > 0 && (
            <div className="field" style={{ marginTop: "1rem", maxWidth: "32rem" }}>
              <label htmlFor="delivery_id">Which delivery</label>
              <select id="delivery_id" name="delivery_id" value={matchedDeliveryId}
                onChange={(e) => matchDelivery(e.target.value)} disabled={!customerId}>
                <option value="">
                  {customerId ? "Choose the delivery this bills" : "Choose a customer first"}
                </option>
                {openDeliveries.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.doc_no} · {String(d.doc_date).slice(0, 10)} · {d.lines.length} line{d.lines.length === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
              <span className="hint">
                {matchedDeliveryId
                  ? "Lines filled from it, and held to what actually went out"
                  : "For stock that already left and just needs its invoice"}
              </span>
            </div>
          )}

          {fulfilMode === "later" && <input type="hidden" name="to_deliver" value="on" />}

          {/* Only where it is a warning. Under "already gone" the customer's
              waiting deliveries are the point, not a mistake. */}
          {fulfilMode !== "match" && openDeliveries.length > 0 && (
            <div className="alert" style={{ marginTop: "0.75rem" }}>
              {customer?.name ?? "This customer"} already ha{openDeliveries.length === 1 ? "s" : "ve"}{" "}
              {openDeliveries.length} deliver{openDeliveries.length === 1 ? "y" : "ies"} waiting for an
              invoice. If this sale is for stock that already left, choose
              &ldquo;Already gone&rdquo; instead — otherwise{" "}
              {fulfilMode === "later" ? "this creates yet another one waiting" : "the same stock leaves twice"}.
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Items</h2>
          {lines.some((l) => l.sourceLineId || l.orderLineId) && (
            <label className="billpart">
              <input type="checkbox" checked={billPart}
                     onChange={(e) => billWholeDelivery(e.target.checked)} />
              {lines.some((l) => l.orderLineId)
                ? "Invoice part of the order"
                : "Bill only part of what went out"}
            </label>
          )}
          <button type="button" className="ghost tiny" onClick={addLine}>Add line</button>
        </div>
        {billPart && (
          <p className="hint" style={{ padding: "0 1rem 0.5rem" }}>
            Reduce a quantity to bill less than was delivered. Whatever is left
            stays on the delivery, waiting for the next invoice — it is not
            written off.
          </p>
        )}
        <div className="tablewrap">
          <table className="linetable">
            <thead>
              <tr>
                <th>Item</th>
                {!toDeliver && !matchedDeliveryId && anyConsigned && <th>Stock source</th>}
                <th className="r">On hand</th>
                <th>Unit</th>
                <th className="r">Qty</th>
                <th className="r">Price</th>
                <th className="r">Disc %</th>
                <th className="r">Free</th>
                <th className="r">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.flatMap((l) => {
                const item = byId(l.itemId);
                const free = freeQty(l);
                const short = !toDeliver && !matchedDeliveryId && item?.is_stocked
                  && (Number(l.qty) + free) * factorOf(l) > onHandHere(l.itemId);
                const promo = promoFor(l.itemId);

                /* Why these units are free, which is not always a promotion.
                   Free quantity has two sources — earned from a buy-N-get-M
                   band, and typed on the line by whoever is selling — and the
                   second is independent of any promotion, as givenFree says.
                   This read `promo!.code`, asserting a promotion the line
                   need not have: typing a free quantity against an item with
                   no band made it null, and the whole voucher screen died
                   with "Application error" the moment the number was
                   entered. */
                const freeBadge =
                  earnedFree(l) > 0 && promo
                    ? promo.code
                    : (focReasons.find((r) => r.id === l.focReasonId)?.code ?? "FREE");

                const freeRow =
                  free > 0 && item ? (
                    <tr key={`${l.key}-free`}>
                      <td style={{ paddingLeft: "1.6rem" }}>
                        <span style={{ color: "var(--ghost)" }}>└ </span>
                        <span className="m">{item.code}</span>{" "}
                        <span className="pill warn">{freeBadge}</span>
                      </td>
                      {!toDeliver && !matchedDeliveryId && anyConsigned && <td />}
                      <td className="r" style={{ color: "var(--muted)" }}>free</td>
                      <td className="r">{fmt(free)}</td>
                      <td className="r" style={{ color: "var(--muted)" }}>0</td>
                      <td />
                      <td />
                      <td className="r" style={{ color: "var(--muted)" }}>0</td>
                      <td />
                    </tr>
                  ) : null;

                return [
                  <tr key={l.key}>
                    <td style={{ minWidth: 240 }}>
                      {/* An order line's item is the order's: changing what is
                          being sold starts there. */}
                      {l.orderLineId ? (
                        <span className="readout" title="On the order — change it there">
                          {item ? `${item.code} · ${item.name}` : "—"}
                        </span>
                      ) : (
                        <ItemPicker
                          mode="sales"
                          items={items}
                          categories={categories}
                          uoms={uoms}
                          value={l.itemId}
                          onPick={(id) => pickItem(l.key, id)}
                          onCreated={addItem}
                        />
                      )}
                      {/* These are the goods an open order is waiting for. */}
                      <AlreadyAwaited
                        lines={awaited.filter((a) => a.item_id === l.itemId)}
                        sales
                        backTo="/sales/new"
                      />
                    </td>
                    {!toDeliver && !matchedDeliveryId && anyConsigned && (
                      <td style={{ minWidth: 170 }}>
                        {(() => {
                          if (!l.itemId || !item?.is_stocked)
                            return <span style={{ color: "var(--muted)" }}>—</span>;
                          const split = splitFor(l.itemId);
                          if (split.consigned.length === 0) {
                            return (
                              <span className="sourcebtn" style={{ cursor: "default", border: 0 }}>
                                <span className="pooldot owned" /> Company-owned
                              </span>
                            );
                          }
                          const pools = poolsFor(split);
                          const chosen = pools.find((p) => p.key === l.source) ?? pools[0];
                          return (
                            <button type="button" className="sourcebtn"
                                    onClick={() => setSourceFor(l.key)}>
                              <span className={`pooldot ${l.source === "OWNED" ? "owned" : "consigned"}`} />
                              <span>{chosen.label.replace("Consignment — ", "")}</span>
                              <span className="avail">{chosen.qty}</span>
                            </button>
                          );
                        })()}
                      </td>
                    )}
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
                    {/* Which unit this line is sold in. Only a picker where
                        the item has packs; otherwise the item's own unit,
                        stated rather than chosen. A line billing a delivery
                        cannot change it — the goods left in whatever they
                        left in. */}
                    <td className="narrow">
                      {(item?.packs ?? []).length > 0 && !l.sourceLineId ? (
                        <select
                          value={l.uomId ?? ""}
                          onChange={(e) => setLine(l.key, { uomId: e.target.value })}
                          aria-label={`Unit for ${item?.code ?? "line"}`}
                        >
                          <option value="">{item?.uom_code}</option>
                          {(item?.packs ?? []).map((p) => (
                            <option key={p.uomId} value={p.uomId}>
                              {p.code} ({Number(p.factor)})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="code" style={{ color: "var(--muted)" }}>
                          {item?.uom_code ?? "—"}
                        </span>
                      )}
                    </td>
                    <td className="narrow">
                      {/* What went out, went out. A line billing a delivery
                          takes its quantity from that delivery: 100 delivered
                          bills 100, and neither 90 nor 110. The price is still
                          yours to set — it is your price list, not a fact
                          about the goods. */}
                      <input type="number" min="0" step="any" value={l.qty} aria-label="Quantity"
                        max={(l.sourceLineId || l.orderLineId) && billPart
                          ? l.sourceQty : undefined}
                        readOnly={!!(l.sourceLineId || l.orderLineId) && !billPart}
                        title={l.sourceLineId ? "Delivered quantity — billed as it went out" : undefined}
                        style={l.sourceLineId && !billPart
                          ? { background: "var(--line-soft)", cursor: "not-allowed" }
                          : undefined}
                        onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                      {l.sourceLineId && billPart
                       && Number(l.qty) < Number(l.sourceQty) - 0.0001 && (
                        <span className="qtyleft">
                          {fmt(Number(l.sourceQty) - Number(l.qty))} left to bill
                        </span>
                      )}
                    </td>
                    <td className="narrow">
                      {/* An agreed price is not a suggestion. A line billing a
                          delivery that came out of an order carries the price
                          that order agreed, and typing over it here would put
                          the invoice and the order at odds with nothing
                          recording which is right. Correcting the agreement is
                          done at the order, where it is versioned and reasoned
                          — and from there it carries into this bill. */}
                      <input type="number" min="0" step="any" value={l.unitPrice} aria-label="Unit price"
                        readOnly={l.agreedPrice !== null && l.agreedPrice !== undefined}
                        title={l.agreedPrice != null
                          ? `Agreed on ${l.orderNo ?? "the order"}`
                          : undefined}
                        style={l.agreedPrice != null
                          ? { background: "var(--line-soft)", cursor: "not-allowed" }
                          : undefined}
                        onChange={(e) => setLine(l.key, { unitPrice: e.target.value })} />
                    </td>
                    <td className="tight">
                      <input type="number" min="0" max="100" step="any" value={l.discountPct} aria-label="Discount percent"
                        onChange={(e) => setLine(l.key, { discountPct: e.target.value })} />
                    </td>
                    {/* Given away on this line. Not a discount: these units
                        are charged at nothing and still leave the warehouse,
                        so they need a reason of their own to cost against. */}
                    <td className="narrow">
                      <input type="number" min="0" step="any" value={l.focQty} aria-label="Free quantity"
                        placeholder="0"
                        onChange={(e) => setLine(l.key, { focQty: e.target.value })} />
                      {givenFree(l) > 0 && (
                        <select value={l.focReasonId} aria-label="Reason free"
                                style={{ marginTop: "0.2rem" }}
                                onChange={(e) => setLine(l.key, { focReasonId: e.target.value })}>
                          {focReasons.map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                      )}
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

          {/* Commercial tax sits with the total it changes, not in a card
              further down the form: it is the difference between what the
              goods sold for and what the customer hands over. */}
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
            <label className="totalbar-tax" title="Prices as typed already contain the tax">
              <input
                type="checkbox"
                name="price_includes_tax"
                checked={inclusive}
                onChange={(e) => setInclusive(e.target.checked)}
              />
              <span style={{ color: "var(--muted)" }}>Prices include tax</span>
            </label>
          )}

          {(deliveryFee > 0 || taxOnGoods > 0) && (
            <span style={{ color: "var(--muted)" }}>
              goods {fmt(goodsNet)}
              {taxOnGoods > 0 && <> + tax {fmt(taxOnGoods)}</>}
              {deliveryFee > 0 && <> + delivery {fmt(deliveryFee)}</>}
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
              {/* Not "delivery fee": this screen already uses delivery for the
                  document recording stock leaving the warehouse, which happens
                  on a counter sale too, so a field of that name reads as
                  something owed on every sale.

                  Disabled rather than removed, so the charge stays visible as
                  something this screen can do — and that is load-bearing, not
                  cosmetic. A disabled input is left out of the submission
                  entirely, so the action sees no field at all, which is the
                  one case it reads as "bill whatever the delivery charged".
                  While this was always enabled, a blank box posted a charge of
                  zero and billing a delivery that carried one silently dropped
                  it: measured, a delivery carrying 7,500 billed at 10,000 with
                  a fee of 0. */}
              {(() => {
                const noCharge = fulfilMode === "counter" || fulfilMode === "match";
                return (
              <div className="field">
                <label htmlFor="delivery_fee">Transport charge to customer</label>
                <input id="delivery_fee" name="delivery_fee" type="number" min="0" step="0.01"
                  value={noCharge ? "" : fee} onChange={(e) => setFee(e.target.value)}
                  placeholder="0" disabled={noCharge} />
                <span className="hint">
                  {fulfilMode === "counter"
                    ? "Nobody carried the goods — the customer took them away."
                    : fulfilMode === "match"
                      ? "Whatever that delivery charged is billed here already."
                      : "Charged for carrying the goods to the customer. Credited to delivery income, not sales, so margin on the products stays honest."}
                </span>
              </div>
                );
              })()}
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

          {/* Under the tabs rather than in a card of its own.
              A card holding one textarea spanned the full width for a line of
              text and pushed the submit button 150px further down; this card
              is shorter than the one beside it and had the room going spare.
              Still always visible, which was the point of taking it out from
              behind a button. */}
          <div className="card-body" style={{ paddingTop: 0 }}>
            <div className="field">
              <label htmlFor="memo">Remark</label>
              <textarea id="memo" name="memo" rows={2}
                        placeholder="Optional — English or Myanmar" />
            </div>
          </div>
        </div>
      </div>

      {/* The prices on this bill came from an order, and are held to it. Said
          once under the table rather than repeated on every line, and it
          offers the way to change them rather than only naming the rule. */}
      {agreedFrom && agreedFrom.orderId && (
        <p className="hint" style={{ marginTop: "0.5rem" }}>
          Prices are the ones {agreedFrom.orderNo} agreed. To change what the
          customer is charged,{" "}
          <Link href={backHere(agreedFrom.orderId)}>
            correct the agreed price on {agreedFrom.orderNo}
          </Link>{" "}
          — it carries into this bill, and both keep their number with the
          reason on the record.
        </p>
      )}

      {shortages.length > 0 && !negativeConfirmed && (
        <div className="alert">
          <strong>Recorded stock is insufficient</strong> for{" "}
          {shortages.map((l) => byId(l.itemId)?.code).join(", ")}. Reduce the
          quantity, receive the stock first, or confirm the goods physically
          exist &mdash; posting will ask before recording negative stock.
        </div>
      )}

      {shortages.length > 0 && negativeConfirmed && (
        <div className="alert">
          <strong>Confirmed:</strong> the goods physically exist though none are
          recorded. This will post negative stock, listed under Inventory
          &rarr; Negative stock until a receipt covers it.{" "}
          <button type="button" className="ghost tiny"
                  onClick={() => setNegativeConfirmed(false)}>
            Undo
          </button>
        </div>
      )}

      {cashTooMuch && (
        <div className="alert">Cash in is more than the invoice total.</div>
      )}

      {/* The customer's standing, stated before it is a problem rather than
          only when posting refuses. A limit nobody can see until they are
          stopped by it teaches nothing. */}
      {standing && !overLimit && onAccount > 0 && (
        <div className="hintbar">
          {customer?.name} may owe {fmt(creditLimit as number)}. Owed now{" "}
          {fmt(exposure)}
          {Number(standing.unbilled_deliveries) > 0 && (
            <> (including {fmt(Number(standing.unbilled_deliveries))} delivered, not yet billed)</>
          )}
          ; this sale leaves {fmt(wouldOwe)} — {fmt((creditLimit as number) - wouldOwe)} to spare.
        </div>
      )}

      {overLimit && !overLimitOk && (
        <div className="alert">
          <strong>Over the credit limit.</strong> {customer?.name} may owe{" "}
          {fmt(creditLimit as number)} and already owes {fmt(exposure)}
          {Number(standing?.unbilled_deliveries ?? 0) > 0 && (
            <> (including {fmt(Number(standing?.unbilled_deliveries ?? 0))} delivered and unbilled)</>
          )}
          . On account this sale adds {fmt(onAccount)}, leaving{" "}
          {fmt(wouldOwe)} — {fmt(wouldOwe - (creditLimit as number))} over.
          <div style={{ marginTop: "0.6rem" }}>
            Take payment now to bring it under, or approve going over:{" "}
            <button type="button" className="ghost tiny"
                    onClick={() => setOverLimitOk(true)}>
              Approve and say why
            </button>
          </div>
        </div>
      )}

      {overLimit && overLimitOk && (
        <div className="alert">
          <strong>Approved:</strong> this sale takes {customer?.name} past their
          limit, to {fmt(wouldOwe)} against {fmt(creditLimit as number)}.
          <div className="field" style={{ marginTop: "0.6rem" }}>
            <label htmlFor="credit_override_reason">Why is it allowed?</label>
            <input
              id="credit_override_reason"
              name="credit_override_reason"
              type="text"
              value={overLimitWhy}
              onChange={(e) => setOverLimitWhy(e.target.value)}
              placeholder="Owner approved — cheque collected on delivery"
            />
            <span className="hint">
              Kept on the invoice for good. Posting refuses an approval with no reason.
            </span>
          </div>
          <button type="button" className="ghost tiny" onClick={() => setOverLimitOk(false)}>
            Undo
          </button>
        </div>
      )}

      {overLimit && overLimitOk && (
        <input type="hidden" name="allow_over_credit_limit" value="true" />
      )}


      {/* Carried to the engine, which refuses negative stock without it. The
          flag comes from answering the dialog, never from the shortage
          merely existing. */}
      {negativeConfirmed && (
        <input type="hidden" name="allow_negative_stock" value="true" />
      )}

      {sourceFor !== null && (() => {
        const line = lines.find((x) => x.key === sourceFor);
        const item = line ? byId(line.itemId) : null;
        return (
          <StockSourceDialog
            open
            itemLabel={item ? `${item.code} · ${item.name}` : "item"}
            pools={poolsFor(line ? splitFor(line.itemId) : undefined)}
            value={line?.source ?? "OWNED"}
            onPick={(key) => setLine(sourceFor, { source: key })}
            onClose={() => setSourceFor(null)}
          />
        );
      })()}

      <NegativeStockConfirm
        open={askNegative}
        shortfalls={shortfalls}
        onCancel={() => setAskNegative(false)}
        onConfirm={() => { setNegativeConfirmed(true); setAskNegative(false); }}
      />

      <div className="actions form-commit">
        <button
          type={shortages.length > 0 && !negativeConfirmed ? "button" : "submit"}
          onClick={
            shortages.length > 0 && !negativeConfirmed
              ? () => setAskNegative(true)
              : undefined
          }
          disabled={pending || total === 0 || cashTooMuch}>
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
