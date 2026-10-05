import postgres from "postgres";

declare global {
  // eslint-disable-next-line no-var
  var __sql: ReturnType<typeof postgres> | undefined;
}

function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");

  // Neon's pooled endpoint is PgBouncer in transaction mode, which does not
  // support prepared statements. postgres.js prepares by default, so every
  // query would fail against a pooled URL unless this is turned off.
  const isPooled = url.includes("-pooler.") || url.includes("pgbouncer=true");

  return postgres(url, {
    // A single connection serialises everything: a page firing six queries
    // through Promise.all would wait for six sequential round trips rather
    // than one. Pooled endpoints sit behind PgBouncer and handle far more
    // than this, so the small pool only ever cost latency.
    max: isPooled ? 8 : process.env.VERCEL ? 3 : 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: isLocal ? false : "require",
    prepare: !isPooled,
    onnotice: () => {},
    transform: { undefined: null },
  });
}

/**
 * Every transaction a signed-in request opens says who opened it.
 *
 * Migration 0123's triggers read app.user_id to fill created_by_id,
 * posted_by_id and acted_by, so the twenty-odd posting functions do not each
 * have to be told who is posting. Set with is_local = true: it ends with the
 * transaction, so a pooled connection cannot hand one person's name to the
 * next piece of work it serves.
 *
 * The person is found before the transaction opens, so the lookup never
 * needs a second connection while the first is held. Outside a request — a
 * test or a script — there is no cookie to read, nobody is stamped, and the
 * columns stay empty, which is the truth.
 */
function stampedBegin(raw: ReturnType<typeof postgres>) {
  const begin = raw.begin.bind(raw) as (...a: unknown[]) => Promise<unknown>;
  (raw as unknown as { begin: unknown }).begin = async (...args: unknown[]) => {
    let userId: string | null = null;
    try {
      const { currentUser } = await import("./session");
      userId = (await currentUser())?.id ?? null;
    } catch {
      userId = null;
    }
    const fn = args[args.length - 1] as (tx: unknown) => unknown;
    const opts = args.slice(0, -1);
    return begin(...opts, async (tx: ReturnType<typeof postgres>) => {
      if (userId) await tx`select set_config('app.user_id', ${userId}, true)`;
      return fn(tx);
    });
  };
  return raw;
}

// Reuse across hot reloads in development.
export const sql = global.__sql ?? stampedBegin(connect());
if (process.env.NODE_ENV !== "production") global.__sql = sql;

// Re-exported so the many pages importing these from "@/lib/db" keep working.
// New code should import from "@/lib/format" directly.
export { money, moneyOrTrace, qty, shortDate, dateTime, timeOfDay, timeAgo, DISPLAY_TZ } from "./format";
