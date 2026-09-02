/**
 * Reading and checking a cash- or bank-receipt spreadsheet.
 *
 * One row is one receipt. The columns are the fields the receipt screen asks
 * for and nothing else, so a person who has filled that form in once already
 * knows what the sheet wants:
 *
 *     Date · Received From · Amount · Cash Account · Branch · Reference · Description
 *
 * Pure, like the item importer: it takes text and existing master data and
 * returns a verdict, writing nothing. The preview a user approves and the
 * import that follows are produced by this same function, which they could
 * not be if producing the preview had side effects.
 *
 * The rule is the same too. The sheet may name an account; whether that is an
 * account, and one that may be posted to by hand, is the database's answer.
 */

export type VoucherKind = "cash" | "bank";

export type VoucherMasterData = {
  accounts: {
    id: string; code: string; name: string;
    is_postable: boolean; is_control: boolean;
    is_cash_account: boolean; is_bank_account: boolean;
  }[];
  locations: { id: string; code: string; name: string; parent_id: string | null; is_active: boolean }[];
  /** Open fiscal periods, so a date nothing covers is caught before posting. */
  openPeriods: { start_date: string; end_date: string }[];
};

export type VoucherIssue = { row: number; column?: string; message: string };

export type PlannedVoucher = {
  row: number;
  docDate: string;
  moneyAccountId: string;
  moneyAccountName: string;
  otherAccountId: string;
  otherAccountName: string;
  amount: number;
  locationId: string | null;
  locationName: string;
  reference: string | null;
  memo: string | null;
};

export type VoucherPlan = {
  rows: PlannedVoucher[];
  errors: VoucherIssue[];
  warnings: VoucherIssue[];
  summary: { rows: number; receipts: number; total: number; accounts: number };
};

const norm = (s: string) => s.trim().toLowerCase();

/** Columns for each kind — only the money account's label differs. */
export function voucherColumns(kind: VoucherKind): string[] {
  return ["No", "Date", kind === "cash" ? "Cash Account" : "Bank Account",
          "Received From", "Amount", "Branch", "Reference", "Description"];
}

/**
 * Excel hands back a date as a Date, which xlsxToRows renders as YYYY-MM-DD.
 * A CSV brings whatever was typed. Both are accepted, along with the
 * day-first forms people actually write, because rejecting 02/09/2026 while
 * accepting 2026-09-02 would be pedantry rather than safety.
 *
 * Ambiguity is the one thing not guessed at: 03/04/2026 is refused rather
 * than silently read as March or April, since a receipt in the wrong month
 * lands in the wrong period and nobody notices until it is closed.
 */
export function parseDate(raw: string): { date: string } | { error: string } {
  const v = raw.trim();
  if (!v) return { error: "Date is empty." };

  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return ymd(+iso[1], +iso[2], +iso[3]);

  const slash = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (slash) {
    const a = +slash[1], b = +slash[2], year = +slash[3];
    if (a > 12 && b > 12) return { error: `"${v}" is not a real date.` };
    if (a > 12) return ymd(year, b, a);          // unambiguous: day first
    if (b > 12) return ymd(year, a, b);          // unambiguous: month first
    if (a === b) return ymd(year, a, b);         // same either way
    return {
      error:
        `"${v}" could be ${a}/${b} or ${b}/${a} — day-first or month-first. ` +
        `Write it as YYYY-MM-DD so it cannot be read as the wrong month.`,
    };
  }
  return { error: `"${v}" is not a date this can read. Use YYYY-MM-DD.` };
}

function ymd(y: number, m: number, d: number): { date: string } | { error: string } {
  if (m < 1 || m > 12 || d < 1 || d > 31) return { error: `${y}-${m}-${d} is not a real date.` };
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { error: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")} is not a real date.` };
  }
  return { date: dt.toISOString().slice(0, 10) };
}

export function planVoucherImport(
  rowsIn: string[][], master: VoucherMasterData, kind: VoucherKind
): VoucherPlan {
  const errors: VoucherIssue[] = [];
  const warnings: VoucherIssue[] = [];
  const rows: PlannedVoucher[] = [];
  const empty = { rows: 0, receipts: 0, total: 0, accounts: 0 };

  if (rowsIn.length === 0) {
    return { rows, errors: [{ row: 0, message: "The file is empty." }], warnings, summary: empty };
  }

  const columns = voucherColumns(kind);
  const moneyColumn = columns[2];
  const required = ["Date", moneyColumn, "Received From", "Amount"];

  const header = rowsIn[0].map((h) => h.trim());
  const indexOf = new Map<string, number>();
  header.forEach((h, i) => indexOf.set(norm(h), i));

  const missing = required.filter((c) => !indexOf.has(norm(c)));
  if (missing.length > 0) {
    errors.push({ row: 1, message: `Missing column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}` });
    return { rows, errors, warnings, summary: empty };
  }
  const cell = (r: string[], name: string) => {
    const i = indexOf.get(norm(name));
    return i === undefined ? "" : (r[i] ?? "").trim();
  };

  const accountsByKey = new Map<string, VoucherMasterData["accounts"][number]>();
  for (const a of master.accounts) { accountsByKey.set(norm(a.name), a); accountsByKey.set(norm(a.code), a); }
  const locationsByKey = new Map<string, VoucherMasterData["locations"][number]>();
  for (const l of master.locations) { locationsByKey.set(norm(l.name), l); locationsByKey.set(norm(l.code), l); }

  const moneyAccounts = master.accounts.filter((a) =>
    kind === "cash" ? a.is_cash_account && !a.is_bank_account : a.is_bank_account);

  const seenAccounts = new Set<string>();

  for (let i = 1; i < rowsIn.length; i++) {
    const r = rowsIn[i];
    const rowNo = i + 1;
    const before = errors.length;
    const add = (message: string, column?: string) => errors.push({ row: rowNo, column, message });

    // ---- date -------------------------------------------------------------
    const dateResult = parseDate(cell(r, "Date"));
    let docDate = "";
    if ("error" in dateResult) add(dateResult.error, "Date");
    else {
      docDate = dateResult.date;
      const covered = master.openPeriods.some((p) => docDate >= p.start_date && docDate <= p.end_date);
      if (!covered) {
        add(
          `${docDate} is not in an open accounting period, so nothing can be posted to it. ` +
          `Check the date, or reopen the period first.`, "Date"
        );
      }
    }

    // ---- the money side ---------------------------------------------------
    const moneyText = cell(r, moneyColumn);
    const money = accountsByKey.get(norm(moneyText));
    if (!moneyText) {
      add(`${moneyColumn} is empty — say which account the money arrived in.`, moneyColumn);
    } else if (!money) {
      add(`${moneyColumn} "${moneyText}" is not an account here.` +
          nearest(moneyText, moneyAccounts), moneyColumn);
    } else if (kind === "cash" ? !money.is_cash_account : !money.is_bank_account) {
      add(
        `"${money.name}" is not marked as a ${kind} account, so it cannot be the ${kind} side of a receipt.` +
        nearest(moneyText, moneyAccounts), moneyColumn
      );
    }

    // ---- the other side ---------------------------------------------------
    const otherText = cell(r, "Received From");
    const other = accountsByKey.get(norm(otherText));
    if (!otherText) {
      add("Received From is empty — say which account the money came from.", "Received From");
    } else if (!other) {
      add(`Received From "${otherText}" is not an account here.` +
          nearest(otherText, master.accounts.filter((a) => a.is_postable && !a.is_control)),
          "Received From");
    } else if (!other.is_postable) {
      add(`"${other.name}" is a heading in the chart, not an account anything can post to. ` +
          `Name one of the accounts under it.`, "Received From");
    } else if (other.is_control) {
      // The guard in the database would refuse this anyway; saying why here
      // is more use than a constraint violation at the end of the import.
      add(
        `"${other.name}" is a control account — it is maintained by the sales and purchase ` +
        `ledgers, and a receipt entered against it by hand would put the subledger out of step ` +
        `with the ledger. Record a customer receipt against the invoice instead.`, "Received From"
      );
    } else if (money && other.id === money.id) {
      add("Received From is the same account the money went into, which posts nothing.", "Received From");
    }

    // ---- amount -----------------------------------------------------------
    const amountText = cell(r, "Amount").replace(/,/g, "");
    const amount = Number(amountText);
    if (!amountText) add("Amount is empty.", "Amount");
    // A negative is caught before the digits-only test, or it would be
    // reported as "not a number" — true but unhelpful, when the real answer
    // is that the entry belongs on a different screen.
    else if (/^-\d/.test(amountText)) {
      add("Amount cannot be negative. Money going the other way is a payment, entered on the payment screen.", "Amount");
    } else if (!/^\d+(\.\d+)?$/.test(amountText)) {
      add(`Amount "${cell(r, "Amount")}" is not a number. Write digits only — no currency symbol and no unit.`, "Amount");
    } else if (amount <= 0) {
      add("Amount must be more than zero.", "Amount");
    }

    // ---- branch, optional but resolved when given -------------------------
    const branchText = cell(r, "Branch");
    let location: VoucherMasterData["locations"][number] | undefined;
    if (branchText) {
      location = locationsByKey.get(norm(branchText));
      const branchesOnly = master.locations.filter((l) => l.parent_id === null && l.is_active);
      if (!location) {
        add(`Branch "${branchText}" does not exist.` + nearest(branchText, branchesOnly), "Branch");
      } else if (!location.is_active) {
        add(`Branch "${branchText}" is inactive.`, "Branch");
      } else if (location.parent_id !== null) {
        // A warehouse rolls up to its branch, so the figures would come out
        // right either way — but a receipt is taken at a branch, not in a
        // shed, and letting the sheet say otherwise makes the column mean two
        // different things depending on who filled it in.
        const parent = master.locations.find((l) => l.id === location!.parent_id);
        add(
          `"${branchText}" is a warehouse, not a branch. Money is received at a branch; ` +
          (parent ? `this one sits inside "${parent.name}", so name that instead.`
                  : `name the branch it belongs to instead.`),
          "Branch"
        );
      }
    } else {
      warnings.push({
        row: rowNo, column: "Branch",
        message: "Branch is blank — this receipt will not appear in any branch's figures.",
      });
    }

    if (errors.length > before) continue;

    rows.push({
      row: rowNo,
      docDate,
      moneyAccountId: money!.id,
      moneyAccountName: money!.name,
      otherAccountId: other!.id,
      otherAccountName: other!.name,
      amount,
      locationId: location?.id ?? null,
      locationName: location?.name ?? "—",
      reference: cell(r, "Reference") || null,
      memo: cell(r, "Description") || null,
    });
    seenAccounts.add(other!.id);
  }

  return {
    rows, errors, warnings,
    summary: {
      rows: Math.max(0, rowsIn.length - 1),
      receipts: rows.length,
      total: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 10000) / 10000,
      accounts: seenAccounts.size,
    },
  };
}

/** " Did you mean X?", when there is an obvious candidate. */
function nearest(typed: string, candidates: { name: string }[]): string {
  const t = norm(typed);
  if (!t) return "";
  const exactish = candidates.find((c) => norm(c.name).startsWith(t) || t.startsWith(norm(c.name)));
  if (exactish) return ` Did you mean "${exactish.name}"?`;
  const firstWord = t.split(/\s+/)[0];
  if (firstWord.length >= 3) {
    const same = candidates.find((c) => norm(c.name).split(/\s+/)[0] === firstWord);
    if (same) return ` Did you mean "${same.name}"?`;
  }
  return "";
}
