// Applies db/migrations in order, tracking what has already run.
//
//   node scripts/migrate.mjs             -- apply pending migrations
//   node scripts/migrate.mjs --seed      -- then apply db/seed.sql
//   node scripts/migrate.mjs --reset     -- drop everything and start over
//
// Reads DATABASE_URL from the environment, falling back to .env.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return null;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

const url = loadEnv();
if (!url) {
  console.error("DATABASE_URL is not set (checked environment and .env)");
  process.exit(1);
}

const reset = process.argv.includes("--reset");
const seed = process.argv.includes("--seed");
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  if (reset) {
    process.stdout.write("  resetting schema ... ");
    await sql.unsafe("drop schema public cascade; create schema public;");
    console.log("ok");
  }

  await sql.unsafe(`
    create table if not exists schema_migration (
      filename    text primary key,
      checksum    text        not null,
      applied_at  timestamptz not null default now()
    );
  `);

  const applied = new Map(
    (await sql`select filename, checksum from schema_migration`).map((r) => [
      r.filename,
      r.checksum,
    ])
  );

  const dir = join(root, "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;

  for (const f of files) {
    const body = readFileSync(join(dir, f), "utf8");

    // Hash with line endings normalised. Git checks these files out as CRLF
    // on Windows and LF elsewhere, so hashing raw bytes makes the same
    // migration look edited depending on who ran it — which would block
    // every Windows developer on a repo migrated from a Mac, and vice versa.
    // The checksum is meant to catch content changes, not whitespace.
    const normalised = body.split("\r\n").join("\n");
    const checksum = createHash("sha256").update(normalised).digest("hex").slice(0, 16);
    const legacyChecksum = createHash("sha256").update(body).digest("hex").slice(0, 16);

    if (applied.has(f)) {
      const stored = applied.get(f);

      // A checksum recorded before this normalisation is still valid; adopt
      // the normalised one so it stops mattering.
      if (stored !== checksum && stored === legacyChecksum) {
        await sql`update schema_migration set checksum = ${checksum} where filename = ${f}`;
        console.log(`  ${f} ... already applied (checksum normalised)`);
        continue;
      }

      if (stored !== checksum) {
        // An applied migration that has since been edited means the database
        // and the repo disagree about history. Fail loudly rather than guess.
        throw new Error(
          `${f} has changed since it was applied.\n` +
            `  Applied checksum: ${applied.get(f)}\n` +
            `  Current checksum: ${checksum}\n` +
            `  Write a new migration, or re-run with --reset in development.`
        );
      }
      console.log(`  ${f} ... already applied`);
      continue;
    }

    process.stdout.write(`  ${f} ... `);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migration (filename, checksum)
               values (${f}, ${checksum})`;
    });
    console.log("applied");
    ran++;
  }

  if (seed) {
    process.stdout.write("  seed.sql ... ");
    await sql.unsafe(readFileSync(join(root, "db", "seed.sql"), "utf8"));
    console.log("ok");
  }

  console.log(`\ndone — ${ran} migration(s) applied, ${files.length - ran} already current`);
} catch (err) {
  console.log("FAILED");
  console.error(`\n${err.message}`);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
