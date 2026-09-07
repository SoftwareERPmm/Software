import Link from "next/link";
import { getFinanceData, getAccountLedger, getAccountLedgerSummary } from "@/lib/actions";
import { getCompany, getJournalEntries, getJournalEntryLines } from "@/lib/queries";
import { money } from "@/lib/db";
import { AccountPicker } from "@/components/account-picker";
import { JournalEntryList, type Entry } from "@/components/journal-entry-list";

/**
 * One ledger, read two ways.
 *
 * Every entry in date order answers "what has been posted" — the question
 * asked when looking for a document. One account with a running balance
 * answers "what happened to this account" — the question asked when
 * reconciling. They are the same rows; splitting them across two nav items
 * made the reader choose a screen before knowing which question they had.
 */

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

const LABEL: Record<string, string> = Object.fromEntries(
  TYPES.filter(([v]) => v).map(([v, l]) => [v, l]),
);

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

export default async function GeneralLedger({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string; account?: string; from?: string; to?: string;
    location?: string; type?: string; doc?: string; q?: string;
  }>;
}) {
  const p = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const byAccount = p.view === "account";
  const data = await getFinanceData();
  const list = data.accounts as never as {
    id: string; code: string; name: string; parent_id: string | null; account_type: string;
  }[];
  const tree = data.accountTree as never as {
    id: string; code: string; name: string; parent_id: string | null; is_postable?: boolean;
  }[];
  const locationList = data.branches as never as { id: string; code: string; name: string }[];

  // The querystring carries the whole view, so a link back to the other tab
  // keeps the period someone has already chosen.
  const carry = (over: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...p, ...over })) if (v) next.set(k, String(v));
    const s = next.toString();
    return `/finance/general-ledger${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Accounting</span>
        <h1>General ledger</h1>
        <span className="page-sub">
          Every posted entry, whatever document wrote it. Read it in date
          order to find something, or one account at a time to reconcile a
          balance.
        </span>
      </div>

      <div className="erp-tabs" style={{ marginBottom: "1rem" }}>
        <Link href={carry({ view: undefined })}
              className={`erp-tab ${byAccount ? "" : "here"}`}>All entries</Link>
        <Link href={carry({ view: "account" })}
              className={`erp-tab ${byAccount ? "here" : ""}`}>By account</Link>
      </div>

      {byAccount ? <AccountView p={p} list={list} tree={tree} carry={carry} />
                 : <EntriesView p={p} companyId={company.id}
                                accounts={list} locations={locationList} />}
    </>
  );
}

// ------------------------------------------------------------ all entries --

async function EntriesView({
  p, companyId, accounts, locations,
}: {
  p: Record<string, string | undefined>;
  companyId: string;
  accounts: { id: string; code: string; name: string }[];
  locations: { id: string; code: string; name: string }[];
}) {
  const rows = (await getJournalEntries(companyId, {
    from: p.from, to: p.to, accountId: p.account, locationId: p.location,
    docType: p.type, docNo: p.doc, q: p.q,
  })) as any[];

  const lines = (await getJournalEntryLines(companyId, rows.map((r) => r.id))) as any[];
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
      memo: cleanMemo(r.memo, r.doc_no, docLabel),
      documentId: r.document_id ?? null,
      docNo: r.doc_no ?? null,
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

  // The filters as a querystring, so a link out of the list can bring the
  // reader back to this exact view.
  const backParams = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) backParams.set(k, String(v));
  const backQuery = backParams.toString();

  return (
    <>
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
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="location">Branch / warehouse</label>
              <select id="location" name="location" defaultValue={p.location ?? ""}>
                <option value="">All branches</option>
                {locations.map((l) => (
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
                  <a href="/finance/general-ledger" className="btn ghost tiny">Clear</a>
                )}
              </div>
            </div>
          </div>
          {/* No "Posted by" filter: there is no login, so every entry would
              answer the same. It comes back with roles. */}
        </div>
      </form>

      <JournalEntryList entries={entries} backQuery={backQuery} />
    </>
  );
}

// ------------------------------------------------------------ one account --

async function AccountView({
  p, list, tree, carry,
}: {
  p: Record<string, string | undefined>;
  list: { id: string; code: string; name: string; parent_id: string | null; account_type: string }[];
  tree: { id: string; code: string; name: string; parent_id: string | null; is_postable?: boolean }[];
  carry: (over: Record<string, string | undefined>) => string;
}) {
  if (list.length === 0) return <div className="empty">No accounts are set up.</div>;

  const selected = list.find((a) => a.id === p.account) ?? list[0];
  const rows = (await getAccountLedger(selected.id, p.from, p.to)) as any[];
  const sum = await getAccountLedgerSummary(selected.id, p.from, p.to);

  return (
    <>
      <AccountPicker accounts={list} selectedId={selected.id} tree={tree}
                     basePath="/finance/general-ledger" />

      {/* What it held before, what moved each way, what it holds now. The
          movements below are the working; these are the answer. */}
      <div className="card doc-meta" style={{ marginBottom: "1rem" }}>
        <div className="card-body">
          <div className="erp-settle-figs">
            <div className="erp-settle-fig">
              <span className="erp-settle-label">Opening balance</span>
              <span className="erp-settle-value">{money(sum.opening)}</span>
            </div>
            <div className="erp-settle-fig">
              <span className="erp-settle-label">Total debits</span>
              <span className="erp-settle-value dr">{money(sum.debits)}</span>
            </div>
            <div className="erp-settle-fig">
              <span className="erp-settle-label">Total credits</span>
              <span className="erp-settle-value cr">{money(sum.credits)}</span>
            </div>
            <div className="erp-settle-fig">
              <span className="erp-settle-label">Closing balance</span>
              <span className="erp-settle-value">{money(sum.closing)}</span>
            </div>
          </div>
        </div>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>{selected.code} &middot; {selected.name}</h2>
            <span className="actions">
              <span className="page-sub">
                {rows.length} movement{rows.length === 1 ? "" : "s"}
              </span>
              <Link href={carry({ view: undefined, account: selected.id })}
                    className="btn ghost tiny">See these as entries</Link>
            </span>
          </div>

          {rows.length === 0 ? (
            <div className="empty">Nothing has moved on this account yet.</div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th><th>Entry</th><th>Document</th><th>Narration</th>
                    <th className="r">Debit</th><th className="r">Credit</th><th className="r">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: any, i: number) => (
                    <tr key={i}>
                      <td className="code">
                        {new Date(r.entry_date).toLocaleDateString("en-GB",
                          { day: "2-digit", month: "short", year: "numeric" })}
                      </td>
                      <td className="code">{r.entry_no}</td>
                      <td className="code">{r.doc_no ?? "—"}</td>
                      <td className="wrap">
                        {cleanMemo(r.memo, r.doc_no,
                          LABEL[r.doc_type] ?? r.doc_type ?? "") ?? "—"}
                        {r.partner_name && <div className="subline">{r.partner_name}</div>}
                      </td>
                      <td className="r dr">{Number(r.debit) ? money(r.debit) : ""}</td>
                      <td className="r cr">{Number(r.credit) ? money(r.credit) : ""}</td>
                      <td className="r">{money(r.running_balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>Total</td>
                    <td className="r dr">{money(sum.debits)}</td>
                    <td className="r cr">{money(sum.credits)}</td>
                    <td className="r">{money(sum.closing)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
