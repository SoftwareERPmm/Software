import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  getCompany, getDocument, getDocumentLines, getJournalForDocument,
} from "@/lib/queries";
import { PrintableDocument, type PrintableDoc } from "@/components/printable-document";
import { PrintButton } from "@/components/print-button";

/**
 * A document as paper, for every type.
 *
 * One layout rather than twelve, for the reason the screen has one shell:
 * the differences between an invoice and a delivery note are a title, whose
 * name goes at the top and whether money or quantity is the point — not a
 * different piece of paper.
 *
 * A page of its own rather than @media print over the screen. Printing by
 * subtraction leaves the spacing of a web app on A4, and it cannot be looked
 * at before it comes out of the printer.
 */

const TITLE: Record<string, string> = {
  PURCHASE_ORDER: "Purchase order", GOODS_RECEIPT: "Goods received note",
  PURCHASE_INVOICE: "Purchase invoice", PURCHASE_RETURN: "Purchase return",
  SUPPLIER_PAYMENT: "Payment voucher", SALES_ORDER: "Sales order",
  DELIVERY: "Delivery note", SALES_INVOICE: "Invoice",
  SALES_RETURN: "Credit note", CUSTOMER_RECEIPT: "Receipt voucher",
  STOCK_ADJUSTMENT: "Stock adjustment", STOCK_TRANSFER: "Stock transfer note",
  JOURNAL_VOUCHER: "Journal voucher", CASH_VOUCHER: "Cash voucher",
  BANK_VOUCHER: "Bank voucher", CASH_TRANSFER: "Transfer voucher",
  OPENING_BALANCE: "Opening balances", CONSIGNMENT_RECEIPT: "Consignment receipt",
};

const SUPPLIER_SIDE = new Set([
  "PURCHASE_ORDER", "GOODS_RECEIPT", "PURCHASE_INVOICE", "PURCHASE_RETURN",
  "SUPPLIER_PAYMENT", "CONSIGNMENT_RECEIPT",
]);

/** Which pieces of paper are signed for, and by whom. */
const SIGNATURES: Record<string, string[]> = {
  GOODS_RECEIPT: ["Received by", "Checked by", "Approved by"],
  DELIVERY: ["Delivered by", "Received by", "Approved by"],
  STOCK_TRANSFER: ["Sent by", "Received by", "Approved by"],
  STOCK_ADJUSTMENT: ["Counted by", "Approved by"],
  CUSTOMER_RECEIPT: ["Received by", "Approved by"],
  SUPPLIER_PAYMENT: ["Paid by", "Received by", "Approved by"],
  CASH_VOUCHER: ["Prepared by", "Received by", "Approved by"],
  BANK_VOUCHER: ["Prepared by", "Approved by"],
  JOURNAL_VOUCHER: ["Prepared by", "Approved by"],
  OPENING_BALANCE: ["Prepared by", "Approved by"],
};

const shortDate = (v: unknown) =>
  v ? new Date(String(v)).toLocaleDateString("en-GB",
    { day: "2-digit", month: "short", year: "numeric" }) : "";

export default async function DocumentPrint({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [company, doc] = await Promise.all([getCompany(), getDocument(id)]);
  if (!company || !doc) notFound();

  const d = doc as any;
  const [lines, journal] = await Promise.all([
    getDocumentLines(id) as Promise<any[]>,
    d.journal_entry_id ? getJournalForDocument(d.journal_entry_id) as Promise<any[]> : [],
  ]);

  const title = TITLE[d.doc_type] ?? String(d.doc_type).replace(/_/g, " ").toLowerCase();
  const isSupplier = SUPPLIER_SIDE.has(d.doc_type);

  // A document with item lines is described by them. One without — a voucher,
  // a payment — is described by what it did to the accounts, which is the
  // only record of it there is.
  const hasLines = lines.length > 0;

  const printable: PrintableDoc = {
    company: { name: company.name, nameMy: company.name_my, currency: company.base_currency },
    title,
    docNo: d.doc_no ?? "Draft",
    status: d.status,
    date: shortDate(d.doc_date),
    dueDate: d.due_date ? shortDate(d.due_date) : null,
    reference: d.reference ?? null,
    partnerLabel: isSupplier ? "Supplier" : "Customer",
    partner: d.partner_name ? {
      code: d.partner_code, name: d.partner_name,
      address: d.partner_address ?? null, township: d.partner_township ?? null,
      phone: d.partner_phone ?? null,
    } : null,
    location: d.location_name ?? null,
    memo: d.memo ?? null,
    lines: hasLines ? lines.map((l, i) => ({
      no: i + 1,
      code: l.item_code ?? null,
      name: l.item_name ?? l.description ?? "—",
      qty: l.entered_qty != null ? Number(l.entered_qty) : null,
      uom: l.uom_code ?? null,
      unitPrice: l.unit_price != null ? Number(l.unit_price) : null,
      amount: Number(l.net_amount ?? 0),
    })) : undefined,
    entries: hasLines ? undefined : journal.map((j) => ({
      account: `${j.account_code} · ${j.account_name}`,
      description: j.memo ?? null,
      debit: Number(j.debit),
      credit: Number(j.credit),
    })),
    totals: hasLines
      ? [
          ...(Number(d.net_total) !== Number(d.gross_total)
            ? [{ label: "Subtotal", value: Number(d.net_total) },
               { label: "Tax", value: Number(d.tax_total) }]
            : []),
          { label: "Total", value: Number(d.gross_total), strong: true },
        ]
      : [{ label: "Total", value: journal.reduce((s, j) => s + Number(j.debit), 0), strong: true }],
    signatures: SIGNATURES[d.doc_type],
  };

  return (
    <>
      <div className="actions noprint" style={{ marginBottom: "0.5rem" }}>
        <Link href={`/documents/${id}`} className="btn ghost tiny">
          <ArrowLeft size={13} aria-hidden="true" /> Back to the document
        </Link>
        <PrintButton />
      </div>

      <div className="sheetwrap">
        <PrintableDocument doc={printable} />
      </div>
    </>
  );
}
