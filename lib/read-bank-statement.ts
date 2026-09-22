/**
 * Turning a bank's export into lines we can compare against the ledger.
 *
 * No two banks export the same shape. The columns are named differently, the
 * dates are written differently, and money is sometimes one signed column
 * and sometimes a paid-in column beside a paid-out column. So this does not
 * ask for a template: it reads the header row and works out which column is
 * which, then says so on screen before anything is imported.
 *
 * Guessing wrong is the failure that matters — a paid-out column read as
 * paid-in reverses every sign and reconciles nothing — so the mapping it
 * chose is shown to the person importing, and every row it could not read is
 * listed rather than dropped.
 */

export type StatementRow = {
  lineNo: number;
  txnDate: string;
  description: string | null;
  reference: string | null;
  /** Signed: money into the account is positive. */
  amount: number;
  balance: number | null;
};

export type StatementPlan = {
  /** Which source column was read as what, for showing before import. */
  mapping: {
    date: string | null;
    description: string | null;
    reference: string | null;
    amount: string | null;
    paidIn: string | null;
    paidOut: string | null;
    balance: string | null;
  };
  rows: StatementRow[];
  /** Rows the parser could not read, with why. Never silently dropped. */
  skipped: { rowNo: number; raw: string; why: string }[];
  from: string | null;
  to: string | null;
  netMovement: number;
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Header aliases, widest first — "paid in" must beat a bare "amount". */
const HEADERS: Record<keyof StatementPlan["mapping"], string[]> = {
  date: ["date", "transactiondate", "txndate", "valuedate", "postingdate", "bookingdate"],
  description: ["description", "details", "narrative", "particulars", "remark",
                "remarks", "transactiondetails", "narration"],
  reference: ["reference", "ref", "refno", "referenceno", "chequeno", "chequenumber",
              "transactionid", "transactionref", "utr"],
  amount: ["amount", "transactionamount", "value", "signedamount"],
  paidIn: ["paidin", "credit", "creditamount", "deposit", "deposits", "moneyin",
           "cr", "receipt"],
  paidOut: ["paidout", "debit", "debitamount", "withdrawal", "withdrawals",
            "moneyout", "dr", "payment"],
  balance: ["balance", "runningbalance", "closingbalance", "ledgerbalance"],
};

function findHeaderRow(rows: string[][]): number {
  // The header is the first row in which at least a date-ish and a
  // money-ish column can both be recognised. Bank exports routinely carry
  // two or three title lines above it.
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = rows[i].map(norm);
    const hasDate = cells.some((c) => HEADERS.date.includes(c));
    const hasMoney = cells.some((c) =>
      HEADERS.amount.includes(c) || HEADERS.paidIn.includes(c) || HEADERS.paidOut.includes(c));
    if (hasDate && hasMoney) return i;
  }
  return -1;
}

/** Numbers as banks print them: 1,234.56, (1,234.56) for negative, 1 234,56. */
function toNumber(raw: string): number | null {
  let s = (raw ?? "").trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-\s*$/.test(s)) { negative = true; s = s.replace(/-\s*$/, ""); }
  s = s.replace(/[^\d.,-]/g, "");
  // A comma used as the decimal separator: 1.234,56 or 1234,56.
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  if (s === "" || s === "-") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/**
 * Dates as banks print them.
 *
 * Day-first is assumed where it is ambiguous, because that is what Myanmar
 * banks export and what the rest of this app shows. An ISO date is
 * recognised outright, so an export that does the sensible thing is never
 * second-guessed.
 */
function toDate(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;

  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (dmy) {
    const d = dmy[1].padStart(2, "0");
    const m = dmy[2].padStart(2, "0");
    let y = dmy[3];
    if (y.length === 2) y = `20${y}`;
    if (Number(m) > 12) return null; // month out of range: not day-first after all
    return `${y}-${m}-${d}`;
  }

  // "5 Sep 2026" and friends.
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

export function planBankStatement(rows: string[][]): StatementPlan {
  const empty: StatementPlan = {
    mapping: { date: null, description: null, reference: null, amount: null,
               paidIn: null, paidOut: null, balance: null },
    rows: [], skipped: [], from: null, to: null, netMovement: 0,
  };

  const headerAt = findHeaderRow(rows);
  if (headerAt < 0) {
    return {
      ...empty,
      skipped: [{
        rowNo: 0, raw: "",
        why: "No header row found. The file needs a row naming at least a date "
           + "column and an amount, credit or debit column.",
      }],
    };
  }

  const header = rows[headerAt];
  const at: Record<string, number> = {};
  const mapping = { ...empty.mapping };

  for (const key of Object.keys(HEADERS) as (keyof typeof HEADERS)[]) {
    const idx = header.findIndex((h) => HEADERS[key].includes(norm(h)));
    if (idx >= 0) { at[key] = idx; mapping[key] = header[idx].trim(); }
  }

  const out: StatementRow[] = [];
  const skipped: StatementPlan["skipped"] = [];

  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i];
    const raw = r.join(" | ").trim();
    if (!raw.replace(/\|/g, "").trim()) continue; // a blank spacer row

    const txnDate = at.date !== undefined ? toDate(r[at.date] ?? "") : null;

    // Money: a signed column if there is one, otherwise paid-in minus
    // paid-out. Both may be present and only one filled per row.
    let amount: number | null = null;
    if (at.amount !== undefined) amount = toNumber(r[at.amount] ?? "");
    if (amount === null && (at.paidIn !== undefined || at.paidOut !== undefined)) {
      const inAmt = at.paidIn !== undefined ? toNumber(r[at.paidIn] ?? "") : null;
      const outAmt = at.paidOut !== undefined ? toNumber(r[at.paidOut] ?? "") : null;
      if (inAmt !== null || outAmt !== null) {
        amount = (inAmt ?? 0) - Math.abs(outAmt ?? 0);
      }
    }

    if (!txnDate && amount === null) continue; // a footer or a title line
    if (!txnDate) {
      skipped.push({ rowNo: i + 1, raw, why: "No date could be read from this row" });
      continue;
    }
    if (amount === null) {
      skipped.push({ rowNo: i + 1, raw, why: "No amount could be read from this row" });
      continue;
    }
    if (amount === 0) {
      skipped.push({ rowNo: i + 1, raw, why: "Amount is zero — nothing moved" });
      continue;
    }

    out.push({
      lineNo: out.length + 1,
      txnDate,
      description: at.description !== undefined ? (r[at.description] ?? "").trim() || null : null,
      reference: at.reference !== undefined ? (r[at.reference] ?? "").trim() || null : null,
      amount,
      balance: at.balance !== undefined ? toNumber(r[at.balance] ?? "") : null,
    });
  }

  const dates = out.map((r) => r.txnDate).sort();
  return {
    mapping,
    rows: out,
    skipped,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    netMovement: out.reduce((t, r) => t + r.amount, 0),
  };
}
