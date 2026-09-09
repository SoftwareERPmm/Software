import { CircleCheck, CircleDot, FileText, Landmark, PackageCheck, UserRound } from "lucide-react";
import { shortDate } from "@/lib/db";
import type { DocEvent, Person } from "./document-rail";

/**
 * What happened to this document, and what it is joined to — under it, not
 * beside it.
 *
 * Down the right they cost the lines a fifth of the page: the table is the
 * part somebody reads across, and a history nobody consults until something
 * is wrong was squeezing it. At the foot they are where a reader arrives
 * having already read the document, which is when either becomes interesting.
 *
 * The links take three quarters: they are a table of documents somebody
 * follows, with numbers, dates and quantities across. The history takes one
 * and reads down.
 */

const ICON: Record<string, typeof CircleDot> = {
  POSTED: CircleCheck,
  CREATED: FileText,
  STOCK: PackageCheck,
  BANK: Landmark,
};

const time = (v: unknown) =>
  v ? new Date(String(v)).toLocaleTimeString("en-GB",
    { hour: "2-digit", minute: "2-digit" }) : "";

export function DocumentFooter({
  activity, related, createdBy, postedBy, postedAt,
}: {
  activity: DocEvent[];
  related: React.ReactNode;
  createdBy: Person;
  postedBy: Person;
  postedAt: string | null;
}) {
  return (
    <div className="docfooter">
      <div className="docfooter-links">{related}</div>

      <section className="card docfooter-history">
        <div className="card-head">
          <h2>Activity</h2>
          <span className="page-sub">who did what, and when</span>
        </div>
        <div className="card-body">
          {activity.length === 0 ? (
            <p className="hint">
              {postedBy.name
                ? <>Posted by {postedBy.name}{postedAt ? ` · ${shortDate(postedAt)}` : ""}.</>
                : <>Posted{postedAt ? ` ${shortDate(postedAt)}` : ""}.</>}
            </p>
          ) : (
            <ol className="timeline">
              {activity.map((e, i) => {
                const Icon = ICON[e.kind] ?? CircleDot;
                return (
                  <li key={`${e.happened_at}-${i}`} className={i === 0 ? "now" : ""}>
                    <Icon size={13} aria-hidden="true" />
                    <div>
                      <strong>{e.note ?? e.kind.toLowerCase()}</strong>
                      <span className="page-sub">
                        {shortDate(e.happened_at)} {time(e.happened_at)}
                        {e.actor ? ` · ${e.actor}` : ""}
                      </span>
                    </div>
                    {e.initials !== undefined && (
                      <span className={`avatar ${e.initials ? "" : "avatar-none"}`}>
                        {e.initials ?? <UserRound size={11} aria-hidden="true" />}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {createdBy.name && createdBy.name !== postedBy.name && (
            <p className="hint" style={{ marginTop: "0.6rem" }}>Raised by {createdBy.name}.</p>
          )}
        </div>
      </section>
    </div>
  );
}
