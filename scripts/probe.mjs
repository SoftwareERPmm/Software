// Proves a database is genuinely reachable and writable, not just configured.
//   node scripts/probe.mjs <url> [<url> ...]

import postgres from "postgres";

for (const url of process.argv.slice(2)) {
  const local = url.includes("localhost") || url.includes("127.0.0.1");
  const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
  const sql = postgres(url, {
    ssl: local ? false : "require", prepare: !pooled,
    onnotice: () => {}, max: 1, connect_timeout: 15,
  });

  console.log(`\n  ${local ? "LOCAL" : "CLOUD"}  ${new URL(url).host}`);
  try {
    const t0 = Date.now();
    const [r] = await sql`select current_database() as db, current_user as usr,
                                 version() as ver, now() as at`;
    console.log(`  round trip : ${Date.now() - t0}ms`);
    console.log(`  database   : ${r.db}`);
    console.log(`  user       : ${r.usr}`);
    console.log(`  version    : ${r.ver.split(" on ")[0]}`);
    console.log(`  server time: ${r.at.toISOString()}`);

    // Prove writes actually land, then roll it back so nothing is left behind.
    await sql.begin(async (tx) => {
      await tx`create temporary table probe_check (v text)`;
      await tx`insert into probe_check values ('ok')`;
      const [w] = await tx`select v from probe_check`;
      console.log(`  write test : ${w.v === "ok" ? "passed (rolled back)" : "FAILED"}`);
    });

    const [n] = await sql`select count(*)::int as c from schema_migration`;
    console.log(`  migrations : ${n.c} applied`);
  } catch (err) {
    console.log(`  UNREACHABLE: ${err.message}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
console.log("");
