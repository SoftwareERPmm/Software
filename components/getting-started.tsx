import Link from "next/link";
import { Check } from "lucide-react";

type Status = {
  categories: number;
  items: number;
  customers: number;
  suppliers: number;
  openings: number;
  stockRows: number;
  documents: number;
};

type Step = {
  label: string;
  done: boolean;
  detail: string;
  href: string;
  cta: string;
  /** Required steps block posting entirely; the rest only affect whether the books open correctly. */
  required: boolean;
};

/**
 * Shown only while a company is still being set up. An empty ERP gives no
 * clue what to do first, and the order genuinely matters — an item needs a
 * category to file under, a sale needs a customer, and opening balances have
 * to be in before trading starts or the books open from the wrong figures.
 *
 * Disappears for good once the required steps are done and something has
 * actually been posted, so it never nags an established company.
 */
export function GettingStarted({ status }: { status: Status }) {
  const steps: Step[] = [
    {
      label: "Add a category",
      done: status.categories > 0,
      detail: status.categories > 0
        ? `${status.categories} categor${status.categories === 1 ? "y" : "ies"}`
        : "Items need somewhere to file — nothing unclassified enters stock",
      href: "/items/categories",
      cta: "Add category",
      required: true,
    },
    {
      label: "Add your products",
      done: status.items > 0,
      detail: status.items > 0
        ? `${status.items} item${status.items === 1 ? "" : "s"}`
        : "What you buy and sell",
      href: "/items",
      cta: "Add item",
      required: true,
    },
    {
      label: "Add a customer and a supplier",
      done: status.customers > 0 && status.suppliers > 0,
      detail: status.customers > 0 || status.suppliers > 0
        ? `${status.customers} customer${status.customers === 1 ? "" : "s"}, ${status.suppliers} supplier${status.suppliers === 1 ? "" : "s"}`
        : "One record can be both, if you buy from and sell to the same business",
      href: "/partners/new",
      cta: "Add partner",
      required: true,
    },
    {
      label: "Enter opening cash and bank balances",
      done: status.openings > 0,
      detail: status.openings > 0
        ? "Recorded"
        : "What each account stood at on day one. The difference goes to Opening Balance Equity automatically",
      href: "/finance/opening",
      cta: "Enter balances",
      required: false,
    },
    {
      label: "Enter opening stock",
      done: status.stockRows > 0,
      detail: status.stockRows > 0
        ? "Stock on hand recorded"
        : "Record what is already on the shelf as a stock adjustment, so inventory opens at the right quantity and value",
      href: "/inventory/adjustments",
      cta: "Add stock",
      required: false,
    },
  ];

  const done = steps.filter((s) => s.done).length;

  return (
    <section>
      <div className="card">
        <div className="card-head">
          <h2>Getting started</h2>
          <span className="page-sub">{done} of {steps.length} done</span>
        </div>
        <div className="card-body">
          <ol className="checklist">
            {steps.map((s) => (
              <li key={s.label} className="checklist-item" data-done={s.done || undefined}>
                <span className="checklist-mark" aria-hidden="true">
                  {s.done ? <Check size={13} /> : null}
                </span>
                <span className="checklist-body">
                  <span className="checklist-label">
                    {s.label}
                    {!s.required && !s.done && (
                      <span className="pill" style={{ marginLeft: "0.4rem" }}>recommended</span>
                    )}
                  </span>
                  <span className="checklist-detail">{s.detail}</span>
                </span>
                {!s.done && (
                  <Link href={s.href} className="btn ghost tiny">{s.cta} &rarr;</Link>
                )}
              </li>
            ))}
          </ol>
          <p className="page-sub" style={{ marginTop: "0.9rem" }}>
            Carrying over unpaid invoices from another system? Enter them as
            real invoices rather than one lump sum — receivables and payables
            are tracked per invoice, which is what makes aging and payment
            matching work.
          </p>
        </div>
      </div>
    </section>
  );
}

/** Setup is finished once nothing is blocking posting and real work has begun. */
/**
 * Temporarily off (2026-09-21). The panel and its logic are untouched —
 * flip this back to false and it returns exactly as it was.
 */
const TEMPORARILY_HIDDEN = true;

export function needsGettingStarted(status: Status) {
  if (TEMPORARILY_HIDDEN) return false;
  const readyToPost = status.categories > 0 && status.items > 0
    && status.customers > 0 && status.suppliers > 0;
  const openedProperly = status.openings > 0 && status.stockRows > 0;
  return !(readyToPost && openedProperly && status.documents > 0);
}
