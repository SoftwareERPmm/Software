import { getCompany, getJournalEntries, getJournalEntryLines } from "@/lib/queries";
import { getFinanceData } from "@/lib/actions";
import { JournalEntryList, type Entry } from "@/components/journal-entry-list";

const TYPES: [string, string][] = [
  ["", "All types"],
  ["PURCHASE_ORDER", "Purchase order"],
  ["GOODS_RECEIPT", "Goods receipt"],
  ["PURCHASE_INVOICE", "Purchase invoice"],
  ["PURCHASE_RETURN", "Purchase return"],
  ["SUPPLIER_PAYMENT", "Supplier payment"],
  ["SALES_ORDER", "Sales order"],
  ["DELIVERY", "Delivery"],
  ["SALES_INVOICE", "Sales invoice"],
  ["SALES_RETURN", "Sales return"],
  ["CUSTOMER_RECEIPT", "Customer receipt"],
  ["STOCK_ADJUSTMENT", "Stock adjustment"],
  ["STOCK_TRANSFER", "Stock transfer"],
  ["JOURNAL_VOUCHER", "Journal voucher"],
  ["CASH_VOUCHER", "Cash voucher"],
  ["BANK_VOUCHER", "Bank voucher"],
  ["OPENING_BALANCE", "Opening balance"],
];

const LABEL: Record<string, string> = Object.fromEntries(TYPES.filter(([v]) => v).map(([v, l]) => [v, l]));

/**
 * Posting writes the document number and its own type into the memo — a
 * stock adjustment's reads "SAJ20260906001 stock adjustment". The Document
 * column already carries the number and the Description already names the
 * type, so both halves would appear twice on one line. What survives is the
 * part someone actually typed: "September rent", "settling 1 invoice".
 */
function cleanMemo(memo: string | null, docNo: string | null, label: string): string | null {
  if (!memo) return null;
  let out = memo.trim();
  if (docNo && out.startsWith(docNo)) out = out.slice(docNo.length).trim();
  if (out.toLowerCase() === label.toLowerCase()) return null;
  return out.length > 0 ? out : null;
}

export default async function JournalEntriesPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string; to?: string; account?: string; location?: string;
    type?: string; doc?: string; q?: string;
  }>;
}) {
  const p = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const { accounts, branches } = await getFinanceData();
  const accountList = accounts as never as { id: string; code: string; name: string }[];
  const locationList = branches as never as { id: string; code: string; name: string }[];

  const rows = (await getJournalEntries(company.id, {
    from: p.from, to: p.to, accountId: p.account, locationId: p.location,
    docType: p.type, docNo: p.doc, q: p.q,
  })) as any[];

  const lines = (await getJournalEntryLines(company.id, rows.map((r) => r.id))) as any[];
  const byEntry = new Map<string, any[]>();
  for (const l of lines) {
    const list = byEntry.get(l.journal_entry_id) ?? [];
    list.push(l);
    byEntry.set(l.journal_entry_id, list);
  }

  const entries: Entry[] = rows.map((r) => {
    const docLabel = LABEL[r.doc_type ?? r.source_type]
      ?? (r.doc_type ?? r.source_type ?? "Journal");
    return {
    id: r.id,
    entryNo: r.entry_no,
    entryDate: r.entry_date,
    // Posting writes the document number into the memo ("SAJ20260906001
    // stock adjustment"), and the Document column already carries it. Showing
    // both put the same number twice on one line.
    memo: cleanMemo(r.memo, r.doc_no, docLabel),
    documentId: r.document_id ?? null,
    docNo: r.doc_no ?? null,
    // An entry always says what it came from. source_type is set even where
    // no document row survives, so the description never falls back to blank.
    docLabel,
    status: r.status ?? null,
    partnerName: r.partner_name ?? null,
    debit: Number(r.debit),
    credit: Number(r.credit),
    lines: (byEntry.get(r.id) ?? []).map((l) => ({
      accountCode: l.account_code,
      accountName: l.account_name,
      debit: Number(l.base_amount) > 0 ? Number(l.base_amount) : 0,
      credit: Number(l.base_amount) < 0 ? -Number(l.base_amount) : 0,
      memo: l.memo ?? null,
      partnerName: l.partner_name ?? null,
      locationCode: l.location_code ?? null,
    })),
  };
  });

  const filtered = Boolean(p.from || p.to || p.account || p.location || p.type || p.doc || p.q);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Accounting</span>
        <h1>Journal entries</h1>
        <span className="page-sub">
          Every entry the ledger holds, newest first, whatever posted it.
          Expand a row to see the debits and credits it wrote. The general
          ledger answers the other question — what happened to one account.
        </span>
      </div>

      {/* GET, so a filtered view is a URL: it can be bookmarked, sent to
          someone, and reloaded without re-choosing seven things. */}
      <form method="get" className="card doc-meta" style={{ marginBottom: "1rem" }}>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="from">From</label>
              <input id="from" name="from" type="date" defaultValue={p.from ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="to">To</label>
              <input id="to" name="to" type="date" defaultValue={p.to ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="account">Account</label>
              <select id="account" name="account" defaultValue={p.account ?? ""}>
                <option value="">All accounts</option>
                {accountList.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="location">Branch / warehouse</label>
              <select id="location" name="location" defaultValue={p.location ?? ""}>
                <option value="">All branches</option>
                {locationList.map((l) => (
                  <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="type">Document type</label>
              <select id="type" name="type" defaultValue={p.type ?? ""}>
                {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="doc">Document number</label>
              <input id="doc" name="doc" type="text" defaultValue={p.doc ?? ""}
                     placeholder="e.g. DP20260905001" />
            </div>
            <div className="field">
              <label htmlFor="q">Search</label>
              <input id="q" name="q" type="text" defaultValue={p.q ?? ""}
                     placeholder="Document or memo" />
            </div>
            <div className="field" style={{ justifyContent: "flex-end" }}>
              <div className="actions">
                <button type="submit" className="tiny">Apply</button>
                {filtered && (
                  <a href="/finance/entries" className="btn ghost tiny">Clear</a>
                )}
              </div>
            </div>
          </div>
          {/* No "Posted by" filter: there is no login, so every entry would
              answer the same. It comes back with roles. */}
        </div>
      </form>

      <JournalEntryList entries={entries} />
    </>
  );
}
