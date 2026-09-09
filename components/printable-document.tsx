import { money } from "@/lib/format";

export type PrintLine = {
  no: number;
  code?: string | null;
  name: string;
  qty?: number | null;
  uom?: string | null;
  unitPrice?: number | null;
  amount: number;
};

export type PrintEntry = {
  account: string;
  description?: string | null;
  debit: number;
  credit: number;
};

export type PrintableDoc = {
  company: { name: string; nameMy?: string | null; currency: string };
  title: string;
  docNo: string;
  status?: string | null;
  date: string;
  dueDate?: string | null;
  reference?: string | null;
  partnerLabel?: string;
  partner?: {
    code?: string | null; name: string;
    address?: string | null; township?: string | null; phone?: string | null;
  } | null;
  location?: string | null;
  memo?: string | null;
  lines?: PrintLine[];
  entries?: PrintEntry[];
  totals?: { label: string; value: number; strong?: boolean }[];
  /** Shown only where the paper is actually signed for. */
  signatures?: string[];
};

/**
 * A document as a piece of paper.
 *
 * Screen and paper want opposite things. The screen is a workspace — chrome,
 * links, the workflow strip, everything that helps someone do the next thing.
 * Paper is a record handed to a supplier or filed in a drawer, and every one
 * of those is noise on it. So this is a separate layout rather than the same
 * one with pieces hidden: printing by subtraction leaves a page with the
 * spacing of a web app and the density of one too.
 *
 * Deliberately plain. No colour beyond the ink, because these are printed on
 * whatever is in the office and a pale grey rule that reads as a hairline on
 * screen prints as nothing at all.
 */
export function PrintableDocument({ doc }: { doc: PrintableDoc }) {
  const {
    company, title, docNo, status, date, dueDate, reference,
    partner, partnerLabel = "Party", location, memo, lines, entries, totals, signatures,
  } = doc;

  return (
    <article className="sheet">
      <header className="sheet-head">
        <div>
          <div className="sheet-co">{company.name}</div>
          {company.nameMy && <div className="sheet-co-my name-my">{company.nameMy}</div>}
        </div>
        <div className="sheet-title">
          <h1>{title}</h1>
          <div className="sheet-no">{docNo}</div>
          {status && status !== "POSTED" && (
            <div className="sheet-status">{status}</div>
          )}
        </div>
      </header>

      <section className="sheet-meta">
        <dl>
          <dt>{partnerLabel}</dt>
          <dd>
            {partner ? (
              <>
                <strong>{partner.name}</strong>
                {partner.code && <div className="m">{partner.code}</div>}
                {partner.address && <div>{partner.address}</div>}
                {partner.township && <div>{partner.township}</div>}
                {partner.phone && <div className="m">{partner.phone}</div>}
              </>
            ) : "—"}
          </dd>
        </dl>
        <dl>
          <dt>Date</dt><dd className="m">{date}</dd>
          {dueDate && <><dt>Due</dt><dd className="m">{dueDate}</dd></>}
          {reference && <><dt>Reference</dt><dd className="m">{reference}</dd></>}
          {location && <><dt>Warehouse</dt><dd>{location}</dd></>}
        </dl>
      </section>

      {lines && lines.length > 0 && (
        <table className="sheet-table">
          <thead>
            <tr>
              <th className="c-no">#</th>
              <th>Description</th>
              <th className="c-num">Qty</th>
              <th className="c-uom">Unit</th>
              <th className="c-num">Price</th>
              <th className="c-num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.no}>
                <td className="c-no">{l.no}</td>
                <td>
                  {l.code && <span className="m sheet-code">{l.code}</span>}
                  {l.name}
                </td>
                <td className="c-num">{l.qty != null ? l.qty : ""}</td>
                <td className="c-uom">{l.uom ?? ""}</td>
                <td className="c-num">{l.unitPrice != null ? money(l.unitPrice) : ""}</td>
                <td className="c-num">{money(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {entries && entries.length > 0 && (
        <table className="sheet-table">
          <thead>
            <tr>
              <th className="c-no">#</th>
              <th>Account</th>
              <th>Description</th>
              <th className="c-num">Debit</th>
              <th className="c-num">Credit</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i}>
                <td className="c-no">{i + 1}</td>
                {/* Credits sit in from their debit, the way an entry is
                    written by hand — the only formatting a printed journal
                    has ever needed. */}
                <td style={{ paddingLeft: e.credit ? "1.4rem" : undefined }}>{e.account}</td>
                <td>{e.description ?? ""}</td>
                <td className="c-num">{e.debit ? money(e.debit) : ""}</td>
                <td className="c-num">{e.credit ? money(e.credit) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totals && totals.length > 0 && (
        <table className="sheet-totals">
          <tbody>
            {totals.map((t) => (
              <tr key={t.label} className={t.strong ? "strong" : undefined}>
                <th>{t.label}</th>
                <td className="c-num">{money(t.value)} <span className="sheet-ccy">{company.currency}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {memo && (
        <section className="sheet-memo">
          <div className="sheet-memo-label">Narration</div>
          <div>{memo}</div>
        </section>
      )}

      {signatures && signatures.length > 0 && (
        <section className="sheet-sign">
          {signatures.map((s) => (
            <div key={s}>
              <div className="sheet-rule" />
              <div>{s}</div>
            </div>
          ))}
        </section>
      )}
    </article>
  );
}
