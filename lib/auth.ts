import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { sql } from "./db";

/**
 * Who can reach what.
 *
 * One table of rules, read by two enforcers: middleware.ts refuses a page,
 * and companyId(module) in lib/actions.ts refuses a server action. Hiding a
 * sidebar link is a courtesy on top of those, never the control — a link
 * nobody can see is still a URL anyone can type.
 *
 * Migration 0122 holds the roles; nothing here is stored.
 */

export const ROLES = ["ADMIN", "MANAGER", "SALES", "PURCHASING", "INVENTORY", "ACCOUNTING"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  SALES: "Sales",
  PURCHASING: "Purchasing",
  INVENTORY: "Inventory",
  ACCOUNTING: "Accounting & Finance",
};

export const ROLE_HINT: Record<Role, string> = {
  ADMIN: "Everything, and who can sign in",
  MANAGER: "Everything except managing users",
  SALES: "Orders, deliveries, invoices, receivables, logistics",
  PURCHASING: "Purchase orders, receipts, bills, payables",
  INVENTORY: "Stock, items, warehouses, deliveries and receipts",
  ACCOUNTING: "Cash and bank, journals, ledgers, reports",
};

/** A module is what a page or an action belongs to. Roles are granted modules. */
export type Module = "sales" | "purchasing" | "inventory" | "accounting" | "users";

const GRANTS: Record<Role, Module[] | "all"> = {
  ADMIN: "all",
  MANAGER: ["sales", "purchasing", "inventory", "accounting"],
  SALES: ["sales"],
  PURCHASING: ["purchasing"],
  INVENTORY: ["inventory"],
  ACCOUNTING: ["accounting"],
};

export function hasModule(roles: readonly string[], module: Module): boolean {
  return roles.some((r) => {
    const g = GRANTS[r as Role];
    return g === "all" || (g?.includes(module) ?? false);
  });
}

/** Any of these modules is enough. `[]` means any signed-in person. */
export function hasAny(roles: readonly string[], modules: readonly Module[]): boolean {
  if (modules.length === 0) return true;
  return modules.some((m) => hasModule(roles, m));
}

/**
 * Pages, by path prefix, most specific first. The first prefix that matches
 * decides. Anything not listed is open to every signed-in person — the
 * dashboard, documents, partners, your own account.
 *
 * Deliveries and goods receipts sit under Sales and Purchases in the
 * sidebar, but the people doing them are often the warehouse, so Inventory
 * reaches them too. Receivables and payables are a working list for
 * Accounting as much as for the people who raised the bills.
 */
const PAGE_RULES: [string, Module[]][] = [
  ["/settings/users", ["users"]],
  ["/settings/plan", ["users"]],
  ["/settings", ["accounting"]],
  ["/sales/deliver", ["sales", "inventory"]],
  ["/sales/reports", ["sales", "accounting"]],
  ["/sales/shipped-not-invoiced", ["sales", "accounting"]],
  ["/sales", ["sales"]],
  ["/receivables", ["sales", "accounting"]],
  ["/purchases/receive", ["purchasing", "inventory"]],
  ["/purchases", ["purchasing"]],
  ["/payables", ["purchasing", "accounting"]],
  ["/logistics", ["sales", "inventory"]],
  ["/salespersons", ["sales"]],
  ["/finance", ["accounting"]],
  ["/ledger", ["accounting"]],
  ["/inventory", ["inventory"]],
  ["/items/prices", ["sales", "inventory"]],
  ["/items", ["inventory", "sales", "purchasing"]],
  ["/warehouses", ["inventory"]],
];

export function modulesForPath(path: string): Module[] {
  for (const [prefix, modules] of PAGE_RULES) {
    if (path === prefix || path.startsWith(prefix + "/")) return modules;
  }
  return [];
}

export function canSeePath(roles: readonly string[], path: string): boolean {
  return hasAny(roles, modulesForPath(path.split("?")[0]));
}

// ------------------------------------------------------------- passwords --

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, LEN = 64;

/** scrypt, salted, with its parameters stored beside it so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [kind, n, r, p, salt, key] = stored.split("$");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(key, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), expected.length,
    { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** The rule a new password is held to. Length, because length is what resists guessing. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return "Use at least 8 characters.";
  if (pw.length > 200) return "That password is too long.";
  return null;
}

// -------------------------------------------------------------- sessions --

export const SESSION_COOKIE = "erp_session";
export const SESSION_DAYS = 30;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type SessionUser = {
  id: string;
  name: string;
  initials: string;
  email: string | null;
  roles: Role[];
  mustChangePassword: boolean;
};

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`
    insert into app_session (token_hash, user_id, expires_at)
    values (${hashToken(token)}, ${userId}, now() + make_interval(days => ${SESSION_DAYS}))`;
  return token;
}

/**
 * The person a cookie belongs to, or null.
 *
 * A deactivated person is signed out on their next request, not when their
 * cookie expires: the check is against the user row every time.
 */
export async function userForToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const [row] = await sql`
    select u.id, u.name, u.initials, u.email, u.roles, u.must_change_password, s.id as session_id,
           s.last_seen_at < now() - interval '1 hour' as stale
      from app_session s
      join app_user u on u.id = s.user_id
     where s.token_hash = ${hashToken(token)}
       and s.expires_at > now()
       and u.is_active`;
  if (!row) return null;
  // Touched at most hourly, so reading a page does not write a row every time.
  if (row.stale) {
    await sql`update app_session set last_seen_at = now() where id = ${row.session_id}`;
  }
  return {
    id: row.id, name: row.name, initials: row.initials, email: row.email,
    roles: (row.roles ?? []) as Role[], mustChangePassword: row.must_change_password,
  };
}

export async function endSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await sql`delete from app_session where token_hash = ${hashToken(token)}`;
}

/** Initials for the avatar: first letters of the first two words. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
  return (s || name.trim().slice(0, 2) || "?").toUpperCase().slice(0, 3);
}

// --------------------------------------------------------- document types --

/**
 * Which modules own each kind of document. Read by voiding (you need the
 * role that could have posted it) and by notifications (you only hear about
 * what your roles reach).
 */
export const DOC_TYPE_MODULES: Record<string, Exclude<Module, "users">[]> = {
  SALES_ORDER: ["sales"], SALES_INVOICE: ["sales"], SALES_RETURN: ["sales"], CREDIT_NOTE: ["sales"],
  DELIVERY: ["sales", "inventory"], CUSTOMER_RECEIPT: ["sales", "accounting"],
  PURCHASE_ORDER: ["purchasing"], PURCHASE_INVOICE: ["purchasing"], PURCHASE_RETURN: ["purchasing"],
  DEBIT_NOTE: ["purchasing"], GOODS_RECEIPT: ["purchasing", "inventory"],
  SUPPLIER_PAYMENT: ["purchasing", "accounting"],
  CONSIGNMENT_RECEIPT: ["purchasing", "inventory"], CONSIGNMENT_SETTLEMENT: ["purchasing", "accounting"],
  STOCK_ADJUSTMENT: ["inventory"], STOCK_TRANSFER: ["inventory"],
  CASH_VOUCHER: ["accounting"], BANK_VOUCHER: ["accounting"], JOURNAL_VOUCHER: ["accounting"],
  CASH_TRANSFER: ["accounting"], OPENING_BALANCE: ["accounting"], YEAR_END_CLOSE: ["accounting"],
  ADVANCE_APPLICATION: ["sales", "purchasing", "accounting"],
  ADVANCE_REFUND: ["sales", "purchasing", "accounting"],
};

export const DOC_TYPE_LABEL: Record<string, string> = {
  SALES_ORDER: "sales order", SALES_INVOICE: "sales invoice", SALES_RETURN: "customer return",
  CREDIT_NOTE: "credit note", DELIVERY: "delivery", CUSTOMER_RECEIPT: "customer receipt",
  PURCHASE_ORDER: "purchase order", PURCHASE_INVOICE: "purchase invoice",
  PURCHASE_RETURN: "supplier return", DEBIT_NOTE: "debit note", GOODS_RECEIPT: "goods receipt",
  SUPPLIER_PAYMENT: "supplier payment", CONSIGNMENT_RECEIPT: "consignment receipt",
  CONSIGNMENT_SETTLEMENT: "consignment settlement", STOCK_ADJUSTMENT: "stock adjustment",
  STOCK_TRANSFER: "stock transfer", CASH_VOUCHER: "cash voucher", BANK_VOUCHER: "bank voucher",
  JOURNAL_VOUCHER: "journal voucher", CASH_TRANSFER: "interbranch transfer",
  OPENING_BALANCE: "opening balance", YEAR_END_CLOSE: "year-end close",
  ADVANCE_APPLICATION: "advance application", ADVANCE_REFUND: "advance refund",
};

/** The document types a person's roles reach. */
export function docTypesFor(roles: readonly string[]): string[] {
  return Object.entries(DOC_TYPE_MODULES)
    .filter(([, mods]) => hasAny(roles, mods))
    .map(([t]) => t);
}

/** On for Admin and Manager unless they turned it off; off for others unless they turned it on. */
export function notificationsDefault(roles: readonly string[]): boolean {
  return roles.includes("ADMIN") || roles.includes("MANAGER");
}
