// One test at a time, enforced rather than remembered.
//
// These suites share one database and most of them empty it before they
// start. Two running at once is not a flaky test, it is two programs
// truncating the same tables: deadlocks, foreign keys failing against rows
// another run has just deleted, half-built fixtures, and failures that point
// at whatever was being asserted rather than at the collision. That last part
// is the expensive one — the failures look like defects in the code under
// test, and time goes into investigating a bug that is not there.
//
// It has happened repeatedly, including to a run started deliberately while
// another was still going. "Remember to run them serially" is a rule that
// holds until the moment someone is busy, which is exactly when a wrong
// answer costs most.
//
// ---------------------------------------------------------------------------
// Why a row and not pg_try_advisory_lock
//
// Because the advisory lock does not work here, and fails open rather than
// shut. The database is reached through Neon's pooler, which hands each
// statement to whichever backend is free; a session-level lock taken on one
// backend means nothing to the next statement, which arrives on another.
// Measured, not assumed: two connections to the pooled endpoint both took the
// same lock and both were told they had it. A guard that always says yes is
// worse than none, because it is trusted.
//
// So the lock is a row, which every backend can see. The cost is that a run
// killed outright leaves it behind, which is what STALE_AFTER is for: a lock
// older than any suite could legitimately still be holding is taken over,
// with a note that says so. The window is deliberately far longer than the
// slowest suite — a stale lock costs one confusing wait, a window shorter
// than a real run costs the collision this exists to prevent.
//
// Refused rather than queued. Waiting behind a suite that empties the
// database would start the second one against a half-built world, which is
// the problem rather than the fix.

/** Longer than the slowest suite by a wide margin. */
const STALE_AFTER = "20 minutes";

async function ensureTable(sql) {
  // Created on demand rather than by migration: this is scaffolding for the
  // test runner, not part of the schema the application depends on, and it
  // has no business in a file that runs against pilot or main.
  await sql`
    create table if not exists test_run_lock (
      id         int primary key check (id = 1),
      holder     text        not null,
      started_at timestamptz not null default now()
    )`;
}

/**
 * Take the shared test lock, or refuse.
 *
 * Call it before the first truncate and before any writes — early enough that
 * a refusal costs nothing, which means before the fixtures are built rather
 * than halfway through building them.
 *
 * Release it with releaseTestLock in the same finally block that closes the
 * connection. A run that dies without releasing is covered by STALE_AFTER.
 */
export async function takeTestLock(sql, suiteName = "this suite") {
  await ensureTable(sql);

  const [got] = await sql`
    insert into test_run_lock (id, holder)
    values (1, ${suiteName})
    on conflict (id) do update
       set holder = excluded.holder, started_at = now()
     where test_run_lock.started_at < now() - ${STALE_AFTER}::interval
    returning holder, started_at`;

  if (got) {
    // A run that is killed never reaches its finally block, and the commonest
    // ways to kill one are ordinary: Ctrl-C, or piping the output into
    // something like `head`, which closes the pipe and sends SIGPIPE. Leaving
    // the lock behind then blocks the next twenty minutes of work for a run
    // that ended seconds ago, which is how a guard becomes an obstacle people
    // route around. Handled once here so no suite has to think about it.
    let done = false;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"]) {
      process.once(signal, async () => {
        if (done) return;
        done = true;
        await releaseTestLock(sql);
        process.exit(signal === "SIGINT" ? 130 : 1);
      });
    }
    return;
  }

  const [held] = await sql`
    select holder, extract(epoch from (now() - started_at))::int as seconds
      from test_run_lock where id = 1`;

  throw new Error(
    `Another database test is running: ${held?.holder ?? "unknown"}`
    + `${held?.seconds != null ? `, started ${held.seconds}s ago` : ""}. `
    + `These suites share one database and empty it, so ${suiteName} would `
    + `wreck that run and its own. Wait for it to finish, or point .env at a `
    + `database of your own. If nothing is really running, the lock clears `
    + `itself after ${STALE_AFTER}.`
  );
}

/**
 * Give it back. Safe to call when the lock was never taken.
 *
 * To clear one by hand after a run died in a way nothing could catch:
 *   ./node_modules/.bin/tsx scripts/test-lock.mjs --unlock
 */
export async function releaseTestLock(sql) {
  try {
    await sql`delete from test_run_lock where id = 1`;
  } catch {
    // Teardown must not turn a passing run into a failing one, and the
    // staleness rule covers a lock that outlives its holder anyway.
  }
}

// Run directly to inspect or clear the lock, for the case where a run died in
// a way no handler could catch — a power cut, a SIGKILL, a laptop closing.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
    for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
      if (m) { process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, ""); break; }
    }
  }
  const postgres = (await import("postgres")).default;
  const url = process.env.DATABASE_URL;
  const sql = postgres(url, { ssl: url.includes("localhost") ? false : "require",
    prepare: !url.includes("-pooler."), onnotice: () => {}, max: 1 });
  try {
    await ensureTable(sql);
    const [held] = await sql`
      select holder, extract(epoch from (now() - started_at))::int as seconds
        from test_run_lock where id = 1`;
    if (!held) console.log("  no test lock is held");
    else console.log(`  held by ${held.holder}, started ${held.seconds}s ago`);
    if (process.argv.includes("--unlock") && held) {
      await releaseTestLock(sql);
      console.log("  released");
    }
  } finally {
    await sql.end();
  }
}
