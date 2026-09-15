import Link from "next/link";
import type { LucideIcon } from "lucide-react";

/**
 * The parts a worklist screen is made of — receiving goods, sending them out.
 *
 * Both screens ask the same question of opposite sides of the business: what
 * is still owed, what does it add up to, and what has already happened. They
 * had drifted into two different answers — one stacked every open order's
 * full form down the page, the other led with invoices — so they are built
 * from the same pieces here and differ only in vocabulary.
 *
 * Shared with the order screen's .erp-card, deliberately: a list and a
 * document should not look like two products.
 */

/** Back to the document that sent you here. */
export function ErpBackCrumb({
  listHref, listLabel, doc, here,
}: {
  listHref: string;
  listLabel: string;
  /** The order, bill or invoice this page was opened from. */
  doc?: { id: string; docNo: string } | null;
  here: string;
}) {
  return (
    <div className="erp-crumb">
      <Link href={listHref} className="erp-crumb-link">{listLabel}</Link>
      <span className="erp-crumb-sep">/</span>
      {doc && (
        <>
          <Link href={`/documents/${doc.id}`} className="erp-crumb-link">{doc.docNo}</Link>
          <span className="erp-crumb-sep">/</span>
        </>
      )}
      <span className="erp-crumb-here">{here}</span>
    </div>
  );
}

export function ErpPageHead({
  eyebrow, title, lead, action,
}: {
  eyebrow: string;
  title: string;
  lead: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="erp-pagehead">
      <div>
        <span className="erp-pagehead-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <span className="erp-pagehead-lead">{lead}</span>
      </div>
      {action && <div className="erp-pagehead-actions">{action}</div>}
    </header>
  );
}

export function ErpSection({
  title, count, lead, action, children, foot,
}: {
  title: string;
  /** Shown as a pill beside the title. Omitted rather than drawn as zero. */
  count?: number;
  lead?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  foot?: React.ReactNode;
}) {
  return (
    <section className="erp-card">
      <div className="erp-card-head erp-section-head">
        <div>
          <h2>
            {title}
            {count !== undefined && count > 0 && <span className="erp-count">{count}</span>}
          </h2>
          {lead && <span className="erp-section-lead">{lead}</span>}
        </div>
        {action}
      </div>
      <div className="erp-card-body">{children}</div>
      {foot && <div className="erp-card-foot">{foot}</div>}
    </section>
  );
}

export type Summary = {
  icon: LucideIcon;
  label: string;
  value: string;
  note: string;
  /** "warn" for a figure somebody has to act on. */
  tone?: "warn";
};

/**
 * Three figures across a card. Not period-filtered, and deliberately: two of
 * these are balances that have to agree with a ledger account to the kyat, and
 * a balance cut to "last 30 days" is not that account any more. The one figure
 * that could take a period says the count it covers instead.
 */
export function ErpSummary({ stats }: { stats: Summary[] }) {
  return (
    <div className="erp-summary">
      {stats.map((s) => {
        const Icon = s.icon;
        return (
          <div key={s.label} className={`erp-summary-item${s.tone ? " " + s.tone : ""}`}>
            <span className="erp-summary-icon" aria-hidden="true"><Icon size={18} /></span>
            <div>
              <span className="erp-summary-label">{s.label}</span>
              <strong className="erp-summary-value">{s.value}</strong>
              <span className="erp-summary-note">{s.note}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
