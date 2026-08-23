import type { Metadata } from "next";
import { Inter, Geist_Mono, Noto_Sans_Myanmar } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { getCompany } from "@/lib/queries";
import { NavLink, NavGroup, NavSubGroup } from "./nav";
import { Toast } from "@/components/toast";
import {
  LayoutDashboard, ShoppingCart, Package, Wallet, BookOpen, Boxes, Database,
} from "lucide-react";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
// Vercel's own dashboard/technical typeface — this app leans on mono for
// every label, pill, and table header, so this one swap touches almost
// every screen.
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

// Inter carries no Myanmar glyphs, so every name_my field was falling through
// to whatever the OS happened to ship — Myanmar Text on Windows, Myanmar
// Sangam MN on macOS, something else on a phone. Different machine, different
// rendering, and none of them matched Inter's weight or x-height. Loading this
// explicitly is what makes Burmese look deliberate rather than accidental.
const notoMyanmar = Noto_Sans_Myanmar({
  subsets: ["myanmar"],
  weight: ["400", "500", "600"],
  variable: "--font-myanmar",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Myanmar ERP",
  description: "Inventory and accounting for Myanmar trading and distribution",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let company: Awaited<ReturnType<typeof getCompany>> = null;
  let dbError: string | null = null;

  try {
    company = await getCompany();
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} ${notoMyanmar.variable}`}>
      <body>
        <div className="shell">
          <nav className="sidebar">
            <div className="brand">
              <span className="brand-name">{company?.name ?? "Myanmar ERP"}</span>
              <span className="brand-sub">{company?.base_currency ?? "not set up"}</span>
            </div>

            <NavGroup label="Overview" icon={<LayoutDashboard size={14} />} match={["/"]}>
              <NavLink href="/">Dashboard</NavLink>
              <NavLink href="/documents">All documents</NavLink>
            </NavGroup>

            <NavGroup label="Sales" icon={<ShoppingCart size={14} />} match={["/sales", "/receivables"]}>
              <NavLink href="/sales/orders" exact>Sales orders</NavLink>
              <NavLink href="/sales/deliver">Deliveries</NavLink>
              <NavLink href="/sales/invoices" exact>Sales invoices</NavLink>
              <NavLink href="/sales/returns" exact>Customer returns</NavLink>
              <NavLink href="/receivables" exact>Receivables</NavLink>
              <NavLink href="/receivables/receive">Receive payment</NavLink>
            </NavGroup>

            <NavGroup label="Purchases" icon={<Package size={14} />} match={["/purchases", "/payables"]}>
              <NavLink href="/purchases/orders" exact>Purchase orders</NavLink>
              <NavLink href="/purchases/receive" exact>Goods receipts</NavLink>
              <NavLink href="/purchases/invoices" exact>Purchase invoices</NavLink>
              <NavLink href="/purchases/returns" exact>Supplier returns</NavLink>
              <NavLink href="/payables" exact>Payables</NavLink>
              <NavLink href="/payables/pay">Pay supplier</NavLink>
            </NavGroup>

            <NavGroup label="Cash &amp; Bank" icon={<Wallet size={14} />} match={[
              "/finance/cash-detail", "/finance/bank-detail",
              "/finance/cash-receipt", "/finance/cash-payment",
              "/finance/bank-receipt", "/finance/bank-payment",
              "/finance/transfer",
            ]}>
              <NavLink href="/finance/cash-detail">Cash book</NavLink>
              <NavLink href="/finance/bank-detail">Bank book</NavLink>
              <NavLink href="/finance/cash-receipt">Cash receipt</NavLink>
              <NavLink href="/finance/cash-payment">Cash payment</NavLink>
              <NavLink href="/finance/bank-receipt">Bank receipt</NavLink>
              <NavLink href="/finance/bank-payment">Bank payment</NavLink>
              <NavLink href="/finance/transfer">Interbranch transfer</NavLink>
            </NavGroup>

            <NavGroup label="Accounting" icon={<BookOpen size={14} />} match={[
              "/finance/journal", "/finance/opening", "/finance/general-ledger", "/ledger",
              "/finance/income-statement", "/finance/balance-sheet", "/finance/cash-flow",
            ]}>
              <NavSubGroup label="Transactions" match={["/finance/journal", "/finance/opening"]}>
                <NavLink href="/finance/journal" sub>Journal Entries</NavLink>
                <NavLink href="/finance/opening" sub>Opening Balances</NavLink>
              </NavSubGroup>
              <NavSubGroup label="Ledgers" match={["/finance/general-ledger", "/ledger"]}>
                <NavLink href="/finance/general-ledger" sub>General Ledger</NavLink>
                <NavLink href="/ledger" sub>Trial Balance</NavLink>
              </NavSubGroup>
              <NavSubGroup label="Financial Reports" match={[
                "/finance/income-statement", "/finance/balance-sheet", "/finance/cash-flow",
              ]}>
                <NavLink href="/finance/income-statement" sub>Income Statement</NavLink>
                <NavLink href="/finance/balance-sheet" sub>Balance Sheet</NavLink>
                <NavLink href="/finance/cash-flow" sub>Cash Flow</NavLink>
              </NavSubGroup>
            </NavGroup>

            <NavGroup label="Inventory" icon={<Boxes size={14} />} match={["/items/stock", "/inventory"]}>
              <NavLink href="/items/stock">Stock overview</NavLink>
              <NavLink href="/inventory/movements">Stock movements</NavLink>
              <NavLink href="/inventory/adjustments">Adjustments</NavLink>
              <NavLink href="/inventory/transfer">Transfer</NavLink>
            </NavGroup>

            <NavGroup label="Master data" icon={<Database size={14} />} match={[
              "/partners", "/items", "/warehouses", "/salespersons", "/settings",
            ]}>
              <NavLink href="/partners" exact clearParams={["role"]}>Partners</NavLink>
              <NavLink href="/partners?role=customer" sub>Customers</NavLink>
              <NavLink href="/partners?role=supplier" sub>Suppliers</NavLink>
              <NavLink href="/items" exact>Items</NavLink>
              <NavLink href="/items/categories">Categories</NavLink>
              <NavLink href="/items/subcategories">Sub Categories</NavLink>
              <NavLink href="/items/brands">Brands</NavLink>
              <NavLink href="/warehouses">Warehouses</NavLink>
              <NavLink href="/salespersons">Salespersons</NavLink>
              <NavLink href="/settings/accounts">Chart of Accounts</NavLink>
            </NavGroup>

          </nav>

          <main className="main">
            <div className="inner">
              {dbError ? (
                <div className="card">
                  <div className="card-head"><h2>Database unavailable</h2></div>
                  <div className="card-body">
                    <p className="page-sub">
                      The app could not reach the database. Check that
                      <span className="m"> DATABASE_URL</span> is set and reachable
                      from this environment.
                    </p>
                    <p className="m" style={{ color: "var(--bad)", marginTop: "0.75rem" }}>{dbError}</p>
                  </div>
                </div>
              ) : !company ? (
                <div className="card">
                  <div className="card-head"><h2>Nothing set up yet</h2></div>
                  <div className="card-body">
                    <p className="page-sub">
                      This database is empty. Creating a company builds the chart of
                      accounts, the financial calendar and the posting rules &mdash;
                      everything the ledger needs before anything can be recorded.
                    </p>
                    <div className="actions" style={{ marginTop: "1rem" }}>
                      <Link href="/setup" className="btn">Set up your company</Link>
                    </div>
                  </div>
                </div>
              ) : (
                children
              )}
            </div>
          </main>
        </div>
        <Toast />
      </body>
    </html>
  );
}
