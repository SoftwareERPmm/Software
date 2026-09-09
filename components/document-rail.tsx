import {
  CircleCheck, CircleDot, Clock, FileText, Landmark, PackageCheck, UserRound,
} from "lucide-react";
import { shortDate } from "@/lib/db";

/**
 * The column down the right of a document: what it is, who owes something on
 * it, and what has happened to it.
 *
 * Kept together because they answer one question between them — where does
 * this stand and whose move is it — and kept out of the main column because
 * none of it is the document. The document is the lines and the posting; this
 * is the office around it.
 */

export type Person = { name: string | null; initials: string | null };

export type DocTask = {
  task: string;
  due_date: string | null;
  done_at: string | null;
  responsible: string | null;
  initials: string | null;
  overdue: boolean;
  days_late: number | null;
};

export type DocEvent = {
  kind: string;
  note: string | null;
  happened_at: string;
  actor: string | null;
  initials: string | null;
};

const time = (v: unknown) =>
  v ? new Date(String(v)).toLocaleTimeString("en-GB",
    { hour: "2-digit", minute: "2-digit" }) : "";

/** Initials in a circle. Grey where nobody was recorded, rather than blank. */
export function Avatar({ initials, title }: { initials: string | null; title?: string }) {
  return (
    <span className={`avatar ${initials ? "" : "avatar-none"}`} title={title ?? undefined}>
      {initials ?? <UserRound size={12} aria-hidden="true" />}
    </span>
  );
}

const ICON: Record<string, typeof CircleDot> = {
  POSTED: CircleCheck,
  CREATED: FileText,
  STOCK: PackageCheck,
  BANK: Landmark,
};

export function DocumentRail({
  details, tasks, activity, createdBy, postedBy, postedAt, action,
}: {
  /** Label/value pairs — the document's own identity, in its own words. */
  details: { label: string; value: React.ReactNode }[];
  tasks: DocTask[];
  activity: DocEvent[];
  createdBy: Person;
  postedBy: Person;
  postedAt: string | null;
  /** Whatever the open task wants doing, where the page can offer it. */
  action?: React.ReactNode;
}) {
  const open = tasks.filter((t) => !t.done_at);

  return (
    <aside className="docrail">
      <section className="card">
        <div className="card-head"><h2>Document details</h2></div>
        <div className="card-body">
          <dl className="raildl">
            {details.map((d) => (
              <div key={d.label}>
                <dt>{d.label}</dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {open.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>Task &amp; responsibility</h2></div>
          <div className="card-body">
            {open.map((t) => (
              <dl className="raildl" key={t.task}>
                <div>
                  <dt>Responsible</dt>
                  <dd className="railwho">
                    <Avatar initials={t.initials} />
                    {t.responsible ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt>Task</dt>
                  <dd>{t.task}</dd>
                </div>
                <div>
                  <dt>Due date</dt>
                  <dd style={t.overdue ? { color: "var(--bad)", fontWeight: 600 } : undefined}>
                    {t.due_date ? shortDate(t.due_date) : "—"}
                  </dd>
                </div>
              </dl>
            ))}
            {action && <div className="actions" style={{ marginTop: "0.75rem" }}>{action}</div>}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head"><h2>Activity</h2></div>
        <div className="card-body">
          {activity.length === 0 ? (
            <p className="hint">
              {postedBy.name
                ? <>Posted by {postedBy.name}{postedAt ? ` · ${shortDate(postedAt)}` : ""}.</>
                : "Nothing recorded. Documents posted before this system knew about "
                  + "people carry no name rather than the wrong one."}
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
                  </li>
                );
              })}
            </ol>
          )}
          {createdBy.name && createdBy.name !== postedBy.name && (
            <p className="hint" style={{ marginTop: "0.6rem" }}>
              Raised by {createdBy.name}.
            </p>
          )}
        </div>
      </section>
    </aside>
  );
}

/**
 * The banner a document wears when somebody is late on it. Its own component
 * because it belongs at the very top, above everything the document says
 * about itself: whose move it is outranks what the document contains.
 */
export function TaskBanner({ tasks }: { tasks: DocTask[] }) {
  const late = tasks.filter((t) => !t.done_at && t.overdue);
  if (late.length === 0) return null;

  return (
    <>
      {late.map((t) => (
        <div key={t.task} className="taskbanner">
          <Clock size={15} aria-hidden="true" />
          <div>
            <strong>
              {t.task} overdue · {t.days_late} day{Number(t.days_late) === 1 ? "" : "s"}
            </strong>
            <span className="page-sub">
              Deadline was {t.due_date ? shortDate(t.due_date) : "—"}
              {t.responsible ? ` · ${t.responsible}` : " · unassigned"}
            </span>
          </div>
        </div>
      ))}
    </>
  );
}
