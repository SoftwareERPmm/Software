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
// So the lock is a row, which every backend can see.
//
// The cost is that a run killed outright leaves it behind, and the first
// attempt at covering that was a timer: a lock older than twenty minutes was
// assumed dead and taken over. That is not evidence of death, it is evidence
// of age. A suite that legitimately ran longer would have its lock taken by a
// second runner, both would then be writing to the same database, and — worse
// — when the first finished it would delete a lock it no longer owned,
// letting a third in. The guard would have produced exactly the collision it
// exists to prevent, while reporting that everything was fine.
//
// So liveness is proved rather than assumed. The holder writes a heartbeat
// every few seconds; a lock is only taken over when that heartbeat has
// stopped, which means the process really is gone. And every lock carries an
// owner token: releasing deletes the row only if it is still yours, so a run
// that overran and was superseded cannot clear somebody else's lock on its
// way out.
//
// Refused rather than queued. Waiting behind a suite that empties the
// database would start the second one against a half-built world, which is
// the problem rather than the fix.

import { randomUUID } from "node:crypto";

/** This process's claim, while it holds one. */
let held = null;

/**
 * How long a heartbeat may go missing before the holder is presumed gone.
 *
 * This is not "how long a suite may run" — a suite may run all day as long as
 * it keeps saying so. It is how long after a process dies before its lock can
 * be taken, so it only has to outlast a slow round trip to Neon and a pause
 * for garbage collection, not the slowest test in the repository.
 */
const HEARTBEAT_EVERY_MS = 5_000;
const PRESUMED_DEAD = "90 seconds";

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
  // Added separately so a lock table created by an older version of this file
  // gains them rather than being left without.
  await sql`alter table test_run_lock add column if not exists owner text`;
  await sql`alter table test_run_lock add column if not exists beat_at timestamptz`;
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

  // Whose lock this is. Compared on release, so a run that overran and was
  // superseded cannot delete the lock of whatever took over from it.
  const owner = randomUUID();

  const [got] = await sql`
    insert into test_run_lock (id, holder, owner, beat_at)
    values (1, ${suiteName}, ${owner}, now())
    on conflict (id) do update
       set holder = excluded.holder, owner = excluded.owner,
           started_at = now(), beat_at = now()
     -- Taken over only where the holder has stopped saying it is alive. A row
     -- written before this column existed has no heartbeat and is treated as
     -- dead, which is the only safe reading: nothing is maintaining it.
     where test_run_lock.beat_at is null
        or test_run_lock.beat_at < now() - ${PRESUMED_DEAD}::interval
    returning holder, started_at`;

  if (got) {
    // Kept alive for as long as this process is. unref so it never holds the
    // event loop open: a suite that has finished its work must still be able
    // to exit.
    const beat = setInterval(() => {
      sql`update test_run_lock set beat_at = now()
           where id = 1 and owner = ${owner}`.catch(() => {});
    }, HEARTBEAT_EVERY_MS);
    beat.unref?.();
    held = { owner, beat };

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

  const [who] = await sql`
    select holder,
           extract(epoch from (now() - started_at))::int as seconds,
           extract(epoch from (now() - beat_at))::int as quiet
      from test_run_lock where id = 1`;

  throw new Error(
    `Another database test is running: ${who?.holder ?? "unknown"}`
    + `${who?.seconds != null ? `, started ${who.seconds}s ago` : ""}`
    + `${who?.quiet != null ? ` (last alive ${who.quiet}s ago)` : ""}. `
    + `These suites share one database and empty it, so ${suiteName} would `
    + `wreck that run and its own. Wait for it to finish, or point .env at a `
    + `database of your own. A lock whose holder has stopped answering is `
    + `taken over after ${PRESUMED_DEAD}; one still reporting in is not, `
    + `however long it has been running.`
  );
}

/**
 * Give it back. Safe to call when the lock was never taken.
 *
 * To clear one by hand after a run died in a way nothing could catch:
 *   ./node_modules/.bin/tsx scripts/test-lock.mjs --unlock
 */
export async function releaseTestLock(sql) {
  if (held?.beat) clearInterval(held.beat);
  const owner = held?.owner;
  held = null;
  // Only if it is still ours. A run that overran, was presumed dead and had
  // its lock taken over must not delete the lock of whatever took over from
  // it — that would let a third runner in behind both of them.
  if (!owner) return;
  try {
    await sql`delete from test_run_lock where id = 1 and owner = ${owner}`;
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
      select holder, extract(epoch from (now() - started_at))::int as seconds,
             extract(epoch from (now() - beat_at))::int as quiet
        from test_run_lock where id = 1`;
    if (!held) console.log("  no test lock is held");
    else console.log(`  held by ${held.holder}, started ${held.seconds}s ago,`
      + ` last alive ${held.quiet ?? "never"}s ago`);
    if (process.argv.includes("--unlock") && held) {
      // By hand, so ownership is deliberately not checked — this is the
      // escape hatch for a lock nothing is coming back to clear.
      await sql`delete from test_run_lock where id = 1`;
      console.log("  released");
    }
  } finally {
    await sql.end();
  }
}
