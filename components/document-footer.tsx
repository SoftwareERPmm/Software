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
  activity, related, createdBy, postedBy, postedAt, voided, amended,
}: {
  activity: DocEvent[];
  related: React.ReactNode;
  createdBy: Person;
  postedBy: Person;
  voided?: { name: string | null; at: string; reason: string | null } | null;
  amended?: { name: string | null; at: string; version: number } | null;
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
          {/* Who made it, and who undid or replaced it. A document posted
              before anyone signed in has no name to give, and says so. */}
          <ul className="who-list">
            <li>
              <span className="avatar">{postedBy.initials ?? <UserRound size={11} aria-hidden="true" />}</span>
              <span>
                {postedBy.name ? <>Posted by <strong>{postedBy.name}</strong></> : <>Posted</>}
                {postedAt ? <span className="page-sub"> · {shortDate(postedAt)} {time(postedAt)}</span> : null}
                {!postedBy.name && <span className="page-sub"> · before sign-in was recorded</span>}
              </span>
            </li>
            {createdBy.name && createdBy.name !== postedBy.name && (
              <li>
                <span className="avatar">{createdBy.initials}</span>
                <span>Raised by <strong>{createdBy.name}</strong></span>
              </li>
            )}
            {amended && (
              <li>
                <span className="avatar">{amended.name ? amended.name.slice(0, 2).toUpperCase() : <UserRound size={11} aria-hidden="true" />}</span>
                <span>
                  Replaced by version {amended.version}{amended.name ? <> — <strong>{amended.name}</strong></> : null}
                  <span className="page-sub"> · {shortDate(amended.at)} {time(amended.at)}</span>
                </span>
              </li>
            )}
            {voided && (
              <li className="who-void">
                <span className="avatar">{voided.name ? voided.name.slice(0, 2).toUpperCase() : <UserRound size={11} aria-hidden="true" />}</span>
                <span>
                  Voided{voided.name ? <> by <strong>{voided.name}</strong></> : null}
                  <span className="page-sub"> · {shortDate(voided.at)} {time(voided.at)}</span>
                  {voided.reason && <span className="page-sub"> — &ldquo;{voided.reason}&rdquo;</span>}
                </span>
              </li>
            )}
          </ul>
          {activity.length === 0 ? null : (
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
        </div>
      </section>
    </div>
  );
}
