// Timestamps must render in Myanmar time, not the server's.
//
// Vercel runs in UTC and Yangon is UTC+06:30, so anything recorded before
// half past six in the morning is still "yesterday" in UTC. Rendering that
// raw shows users the wrong day.

// No lock: this suite reads and computes, and writes nothing. See
// scripts/test-lock.mjs for what the others have to take before they start.
process.env.TZ = "UTC"; // match the deployment

const { shortDate, dateTime, timeOfDay, DISPLAY_TZ } = await import("../lib/format.ts");

let bad = 0;
const check = (l, ok, d = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`); };

console.log(`\n  server TZ: ${process.env.TZ}   display TZ: ${DISPLAY_TZ}\n`);

// 22:30 UTC on the 14th is 05:00 on the 15th in Yangon.
const early = "2026-08-14T22:30:00Z";
console.log(`  ${early}`);
console.log(`    raw UTC     ${new Date(early).toISOString().slice(0, 16).replace("T", " ")}`);
console.log(`    dateTime()  ${dateTime(early)}\n`);

check("a late-evening UTC moment shows as next morning in Yangon",
  dateTime(early).includes("15 Aug 2026"), dateTime(early));
check("and carries the local time of day", timeOfDay(early) === "05:00", timeOfDay(early));

// 18:00 UTC on the 14th is 00:30 on the 15th — just past local midnight.
const midnight = "2026-08-14T18:00:00Z";
check("a moment just past local midnight rolls the date forward",
  dateTime(midnight).includes("15 Aug 2026"), dateTime(midnight));
check("shown as 00:30, not 18:00", timeOfDay(midnight) === "00:30", timeOfDay(midnight));

// Same calendar day in both zones.
const daytime = "2026-08-14T02:00:00Z";
check("a daytime moment stays on its own date",
  dateTime(daytime).includes("14 Aug 2026"), dateTime(daytime));
check("shown as 08:30 local", timeOfDay(daytime) === "08:30", timeOfDay(daytime));

// An accounting date is not a moment and must never be shifted.
check("a date-only accounting value is left alone",
  shortDate("2026-04-01") === "01 Apr 2026", shortDate("2026-04-01"));
check("including one that would shift if localised",
  shortDate("2026-12-31") === "31 Dec 2026", shortDate("2026-12-31"));

console.log(bad === 0 ? "\n  timestamps render in Myanmar time\n" : `\n  ${bad} failed\n`);
process.exit(bad === 0 ? 0 : 1);
