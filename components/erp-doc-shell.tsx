import Link from "next/link";
import { ErpDocToolbar, ErpCopyNumber } from "@/components/erp-doc-toolbar";

/**
 * The chrome every document sits in: breadcrumb, action bar with the chevron
 * pipeline, then a sheet.
 *
 * One shell for every document type is the point. Twelve document types
 * rendering the same frame is what makes a set of screens read as one
 * product, and it is a bigger win than any individual screen's polish — so
 * the frame is a component and the differences are props.
 *
 * The body is whatever the page puts inside. This deliberately knows nothing
 * about lines, totals or accounts: it is a frame, and a frame that starts
 * making decisions about content is how one shell becomes twelve again.
 */

export type ChainStage = {
  type: string;
  label: string;
  doc: { id: string; doc_no: string } | null;
  /**
   * Where to go to create this stage, when it does not exist yet and this
   * document is what it would be created from. Set only on the immediate next
   * step, so the pipeline is walkable forwards as well as backwards — a stage
   * further down the chain has nothing to be created from yet.
   */
  href?: string | null;
};

export function ErpDocShell({
  docId, docNo, typeLabel, status, listHref, listLabel,
  chain, actions, badges, children,
}: {
  docId: string;
  docNo: string;
  typeLabel: string;
  status: string;
  listHref: string;
  listLabel: string;
  chain: ChainStage[];
  /** Workflow actions — left of the pipeline, where the reference puts them. */
  actions?: React.ReactNode;
  /** Extra pills beside the number: outstanding, delivered, matched. */
  badges?: React.ReactNode;
  children: React.ReactNode;
}) {
  const currentIndex = chain.findIndex((s) => s.doc?.doc_no === docNo);

  return (
    <div data-density="odoo" className="erp-form">
      <div className="erp-crumb">
        <Link href={listHref} className="erp-crumb-link">{listLabel}</Link>
        <span className="erp-crumb-sep">/</span>
        <span className="erp-crumb-here">{docNo}</span>
        <ErpCopyNumber docNo={docNo} />
        <span style={{ marginLeft: "auto" }}>
          <ErpDocToolbar docId={docId} docNo={docNo} />
        </span>
      </div>

      {(actions || chain.length > 0) && (
        <div className="erp-actionbar">
          <div className="erp-actions">{actions}</div>
          {chain.length > 0 && (
            <div className="erp-pipeline" role="list" aria-label="Workflow">
              {chain.map((stage, i) => {
                const done = !!stage.doc;
                const here = i === currentIndex;
                const body = (
                  <>
                    {stage.label}
                    {stage.doc && !here && <span className="erp-stage-no">{stage.doc.doc_no}</span>}
                    {!stage.doc && stage.href && <span className="erp-stage-no">create</span>}
                  </>
                );
                return (
                  <div key={stage.type} role="listitem"
                       className={`erp-stage ${here ? "here" : done ? "done" : "todo"}${
                         !done && stage.href ? " next" : ""}`}
                       aria-current={here ? "step" : undefined}>
                    {stage.doc && !here
                      ? <Link href={`/documents/${stage.doc.id}`}>{body}</Link>
                      : !stage.doc && stage.href
                        ? <Link href={stage.href}>{body}</Link>
                        : body}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="erp-sheet-page">
        <div className="erp-doc-title">
          <span className="erp-doc-type">{typeLabel}</span>
          <h1>{docNo}</h1>
          <span className={`pill ${status.toLowerCase()}`}>{status}</span>
          {badges}
        </div>
        {children}
      </div>
    </div>
  );
}
