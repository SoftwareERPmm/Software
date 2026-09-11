import Link from "next/link";
import { History, ArrowUpRight } from "lucide-react";
import { money, shortDate } from "@/lib/format";

export type DocumentVersion = {
  id: string;
  version: number;
  status: string;
  gross_total: string | number;
  doc_date: string;
  superseded: boolean;
  reason: string | null;
  acted_at: string | null;
  edited_by: string | null;
};

/**
 * Which version of the number this is — beside the number, where the number
 * is.
 *
 * A corrected document keeps its number, which is the whole point and also
 * the whole danger: two people holding two printouts of SI20260910001 read
 * different figures and neither has any way to tell which is current. So the
 * live one says what version it is, and the retired one says it is retired.
 */
export function VersionBadge({ version, superseded }: { version: number; superseded: boolean }) {
  if (version <= 1 && !superseded) return null;
  return superseded ? (
    <span className="pill warn" title="This version was corrected. A later one stands.">
      Superseded · v{version}
    </span>
  ) : (
    <span className="pill" title="This document has been corrected at least once.">
      Edited · v{version}
    </span>
  );
}

/**
 * The versions of this number, and why each stopped being right.
 *
 * Shown on the document rather than filed away in an audit log, because the
 * question it answers is asked while looking at the document: the supplier
 * says they were told 1,000 and the bill says 1,300, and the answer is that
 * it was corrected on the 10th, by whom, and for what stated reason.
 *
 * Every version stays readable at its own address. Nothing here is editable
 * — a retired version is history, and history that can be edited is not
 * history.
 */
export function VersionTrail({
  versions, currentId,
}: { versions: DocumentVersion[]; currentId: string }) {
  if (versions.length < 2) return null;

  const live = versions.find((v) => !v.superseded && v.status === "POSTED");
  const here = versions.find((v) => v.id === currentId);
  const stale = !!here?.superseded;

  return (
    <div className={`vtrail${stale ? " stale" : ""}`}>
      <div className="vtrail-head">
        <History size={14} aria-hidden="true" />
        <strong>
          {stale
            ? `You are reading v${here?.version}, which was corrected.`
            : `Corrected ${versions.length - 1 === 1 ? "once" : `${versions.length - 1} times`}.`}
        </strong>
        {stale && live && (
          <Link href={`/documents/${live.id}`} className="vtrail-jump">
            Go to v{live.version}, the one that stands <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
        )}
      </div>

      <ol className="vtrail-list">
        {versions.map((v) => {
          const isHere = v.id === currentId;
          return (
            <li key={v.id} className={isHere ? "here" : undefined}>
              <span className="vtrail-v">v{v.version}</span>
              <span className="vtrail-total">{money(v.gross_total)}</span>
              <span className="vtrail-when">{shortDate(v.doc_date)}</span>
              <span className="vtrail-why">
                {v.reason
                  ? <>Corrected{v.acted_at ? ` ${shortDate(v.acted_at)}` : ""}
                      {v.edited_by ? ` by ${v.edited_by}` : ""}: {v.reason}</>
                  : v.superseded
                    ? "Corrected — no reason recorded"
                    : isHere ? "The version you are reading" : "Stands now"}
              </span>
              {isHere
                ? <span className="vtrail-open here">Here</span>
                : <Link href={`/documents/${v.id}`} className="vtrail-open">Open</Link>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
