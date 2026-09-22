import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono, Noto_Sans_Myanmar, DM_Sans } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { getCompany } from "@/lib/queries";
import { NavLink, NavGroup, NavSubGroup } from "./nav";
import { MobileNav } from "@/components/mobile-nav";
import { SidebarCollapse } from "@/components/sidebar-collapse";
import { Toast } from "@/components/toast";
import {
  LayoutDashboard, ShoppingCart, Package, Wallet, BookOpen, Boxes, Database, Truck } from "lucide-react";
import { DatePickerFix } from "@/components/date-picker-fix";

// Plex was drawn for enterprise data rather than for marketing pages: open
// apertures, unambiguous 1/l/I and 0/O, and a lower x-height than Inter, which
// is what stops a screen of forty ledger rows turning into grey texture.
// The dashboard is set in DM Sans: rounder, wider counters, and a taller
// x-height than Plex, which is what makes a headline figure read as a figure
// rather than as data. It leads the stack rather than replacing it — Myanmar
// text still falls through to Noto, because DM Sans has no Burmese glyphs and
// a name in Burmese must not silently lose its shapes to a fallback.
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-dm-sans",
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});

// Its own companion mono, not a third voice. This app sets every label, pill,
// table header and figure in mono, so the pairing carries more of the screen
// than the sans does — the two need to share proportions and weight.
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

// Plex carries no Myanmar glyphs either, so every name_my field would fall through
// to whatever the OS happened to ship — Myanmar Text on Windows, Myanmar
// Sangam MN on macOS, something else on a phone. Different machine, different
// rendering, and none of them matched the Latin face's weight or x-height. Loading this
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
    <html lang="en" className={`${dmSans.variable} ${plexSans.variable} ${plexMono.variable} ${notoMyanmar.variable}`}>
      <body>
        {/* Before first paint, so a rail somebody collapsed yesterday does not
            flash open and shove the page sideways on the way in. The effect in
            SidebarCollapse runs after paint, which is too late to prevent that
            — this is the same reason a theme preference is read here. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('navCollapsed')==='true')"
              + "document.body.dataset.navCollapsed='true'}catch(e){}",
          }}
        />
        <DatePickerFix />
        <div className="shell">
          <MobileNav
            title={company?.name ?? "Myanmar ERP"}
            subtitle={company?.base_currency ?? "not set up"}
          />
          <nav className="sidebar" id="sidebar">
            <div className="brand">
              <span className="brand-name">{company?.name ?? "Myanmar ERP"}</span>
              <span className="brand-sub">{company?.base_currency ?? "not set up"}</span>
            </div>

            <SidebarCollapse />

            <NavGroup label="Overview" icon={<LayoutDashboard size={14} />} match={["/"]}>
              <NavLink href="/">Dashboard</NavLink>
              <NavLink href="/documents" exact>All documents</NavLink>
              <NavLink href="/documents/history">History log</NavLink>
            </NavGroup>

            <NavGroup label="Sales" icon={<ShoppingCart size={14} />} match={["/sales", "/receivables"]}>
              <NavLink href="/sales/orders" exact>Sales orders</NavLink>
              <NavLink href="/sales/deliver">Deliveries</NavLink>
              <NavLink href="/sales/invoices" exact>Sales invoices</NavLink>
              <NavLink href="/sales/consignment">Consignment sale</NavLink>
              <NavLink href="/sales/returns" exact>Customer returns</NavLink>
              <NavLink href="/sales/credit-notes" exact>Credit notes</NavLink>
              <NavLink href="/sales/discounts" exact>Volume discounts</NavLink>
              <NavLink href="/sales/discounts-given" exact>Discounts given</NavLink>
              <NavLink href="/receivables" exact>Receivables</NavLink>
              <NavLink href="/receivables/advances">Customer advances</NavLink>
              <NavLink href="/receivables/receive">Receive payment</NavLink>
            </NavGroup>

            <NavGroup label="Purchases" icon={<Package size={14} />} match={["/purchases", "/payables"]}>
              <NavLink href="/purchases/orders" exact>Purchase orders</NavLink>
              <NavLink href="/purchases/receive" exact>Goods receipts</NavLink>
              <NavLink href="/purchases/invoices" exact>Purchase invoices</NavLink>
              <NavLink href="/purchases/returns" exact>Supplier returns</NavLink>
              <NavLink href="/purchases/debit-notes" exact>Debit notes</NavLink>
              <NavLink href="/payables" exact>Payables</NavLink>
              <NavLink href="/payables/advances">Supplier advances</NavLink>
              <NavLink href="/payables/pay">Pay supplier</NavLink>
            </NavGroup>

            {/* Its own group rather than a tail on Sales: a trip is a yard
                operation with its own masters, and step two adds route plans
                beside it. */}
            <NavGroup label="Logistics" icon={<Truck size={14} />} match={["/logistics"]}>
              <NavLink href="/logistics/routes" exact>Routes</NavLink>
              <NavLink href="/logistics/trips" exact>Delivery trips</NavLink>
              <NavLink href="/logistics/vehicles" exact>Vehicles</NavLink>
              <NavLink href="/logistics/drivers" exact>Drivers</NavLink>
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
              <NavLink href="/finance/bank-reconciliation">Bank reconciliation</NavLink>
              <NavLink href="/finance/transfer">Interbranch transfer</NavLink>
            </NavGroup>

            <NavGroup label="Accounting" icon={<BookOpen size={14} />} match={[
              "/finance/journal", "/finance/opening", "/finance/general-ledger", "/ledger",
              "/finance/income-statement", "/finance/balance-sheet", "/finance/cash-flow",
              "/finance/aging",
            ]}>
              <NavSubGroup label="Transactions" match={["/finance/journal", "/finance/opening"]}>
                <NavLink href="/finance/journal" sub>Journal Voucher</NavLink>
                <NavLink href="/finance/year-end" sub>Year end</NavLink>
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
              {/* Not under Financial Reports. Aging answers "who owes us and
                  how late", which is a working question asked while chasing
                  money — not a statement drawn up at a period end beside the
                  income statement and the balance sheet. */}
              <NavLink href="/finance/aging">AR / AP Aging</NavLink>
            </NavGroup>

            <NavGroup label="Inventory" icon={<Boxes size={14} />} match={["/items/stock", "/inventory"]}>
              <NavLink href="/items/stock">Stock overview</NavLink>
              <NavLink href="/inventory/consignment" exact>Consignment</NavLink>
              <NavLink href="/inventory/movements">Stock movements</NavLink>
              <NavLink href="/inventory/adjustments">Adjustments</NavLink>
              <NavLink href="/inventory/negative-stock">Negative stock</NavLink>
              <NavLink href="/inventory/transfer">Transfer</NavLink>
            </NavGroup>

            <NavGroup label="Master data" icon={<Database size={14} />} match={[
              "/partners", "/items", "/warehouses", "/salespersons", "/settings",
            ]}>
              <NavLink href="/partners" exact clearParams={["role", "category"]}>Partners</NavLink>
              <NavLink href="/partners/categories" exact>Customer categories</NavLink>
              <NavLink href="/partners?role=customer" sub>Customers</NavLink>
              <NavLink href="/partners?role=supplier" sub>Suppliers</NavLink>
              <NavLink href="/items" exact>Items</NavLink>
              <NavLink href="/items/categories">Categories</NavLink>
              <NavLink href="/items/subcategories">Sub Categories</NavLink>
              <NavLink href="/items/brands">Brands</NavLink>
              <NavLink href="/items/units">Units</NavLink>
              <NavLink href="/items/prices">Price list</NavLink>
              <NavLink href="/warehouses">Branches &amp; warehouses</NavLink>
              <NavLink href="/salespersons">Salespersons</NavLink>
              <NavLink href="/settings/accounts">Chart of Accounts</NavLink>
              <NavLink href="/settings/tax-codes">Tax codes</NavLink>
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
