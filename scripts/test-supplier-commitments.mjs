// What a supplier promised, what arrived, and who moved the date.
//
//   npx tsx scripts/test-supplier-commitments.mjs
//
// Touches no database and takes no test lock: lib/supplier-commitments.ts is
// deliberately pure, so every case here is a small number worked out by hand
// and compared against the code. That is the point of the split — the rules
// that decide a supplier's score can be argued with directly, without
// posting a document to find out what they do.

import {
  resolveCommitments, scoreOnTime, onTimePercent, averageDelay, totalOnTime,
} from "../lib/supplier-commitments.ts";

let pass = 0, fail = 0;

const ok = (label, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { pass += 1; console.log(`  PASS  ${label}`); }
  else {
    fail += 1;
    console.log(`  FAIL  ${label}\n        wanted ${JSON.stringify(want)}`
      + `\n        got    ${JSON.stringify(got)}`);
  }
};

const c = (id, qty, confirmedDate, kind, recordedOn) =>
  ({ id, qty, confirmedDate, kind, recordedOn });
const r = (date, qty) => ({ date, qty });

console.log("\nA plain promise, kept");
{
  const { baseline } = resolveCommitments(
    [c("1", 100, "2026-10-10", "INITIAL", "2026-10-01")], [r("2026-10-10", 100)], 100);
  const s = scoreOnTime(baseline, [r("2026-10-10", 100)], "2026-10-31");
  ok("all 100 on the day counts as on time", onTimePercent(s), 100);
  ok("nothing is late", s.late, 0);
}

console.log("\nEarly is on time; a day over is not");
{
  const b = [{ date: "2026-10-10", qty: 50 }];
  ok("arriving early", onTimePercent(scoreOnTime(b, [r("2026-10-05", 50)], "2026-10-31")), 100);
  ok("arriving a day late", onTimePercent(scoreOnTime(b, [r("2026-10-11", 50)], "2026-10-31")), 0);
}

// ---------------------------------------------------------------- check 1 --
console.log("\n1. Quantity-specific partial confirmations");
{
  // 100 for the 10th, then the supplier moves 40 of them to the 17th, and
  // delivers exactly that. The supplier missed 40 units by a week.
  const rows = [
    c("1", 100, "2026-10-10", "INITIAL", "2026-10-01"),
    c("2", 40, "2026-10-17", "SUPPLIER_REVISION", "2026-10-07"),
  ];
  const receipts = [r("2026-10-10", 60), r("2026-10-17", 40)];
  const { baseline, revised, supplierRevisions } =
    resolveCommitments(rows, receipts, 100);

  ok("baseline keeps all 100 on the original date",
    baseline, [{ date: "2026-10-10", qty: 100 }]);
  ok("revised splits the way the supplier said",
    revised, [{ date: "2026-10-10", qty: 60 }, { date: "2026-10-17", qty: 40 }]);
  ok("the revision is counted", supplierRevisions, 1);

  const s = scoreOnTime(baseline, receipts, "2026-10-31");
  ok("60 of 100 on time", onTimePercent(s), 60);
  ok("40 late", s.late, 40);
  ok("each of them by 7 days", averageDelay(s), 7);
}
{
  // The same line without quantity-specific commitments would have to call
  // the whole 100 either punctual or late. This is the case that proves the
  // schedule is doing something a single date could not.
  const wholeLine = scoreOnTime(
    [{ date: "2026-10-17", qty: 100 }], [r("2026-10-10", 60), r("2026-10-17", 40)],
    "2026-10-31");
  ok("a single moved date would have scored it 100%", onTimePercent(wholeLine), 100);
}

// ---------------------------------------------------------------- check 2 --
console.log("\n2. Late-recorded confirmations are not commitments");
{
  // Recorded on the 20th, naming the 10th. A promise about a day gone.
  const backdated = resolveCommitments(
    [c("1", 100, "2026-10-10", "INITIAL", "2026-10-20")], [r("2026-10-10", 100)], 100);
  ok("a backdated promise is ignored", backdated.baseline, []);
  ok("and says why", backdated.ignored.length, 1);

  // Recorded after every unit had arrived, naming a future date. This is the
  // one that would otherwise hand a silent supplier a perfect record.
  const afterTheFact = resolveCommitments(
    [c("1", 100, "2026-10-25", "INITIAL", "2026-10-15")], [r("2026-10-12", 100)], 100);
  ok("a confirmation written after delivery is ignored", afterTheFact.baseline, []);

  // Recorded while the goods were still coming: legitimate.
  const inTime = resolveCommitments(
    [c("1", 100, "2026-10-25", "INITIAL", "2026-10-11")], [r("2026-10-12", 100)], 100);
  ok("one recorded before the goods landed stands",
    inTime.baseline, [{ date: "2026-10-25", qty: 100 }]);
}

// ---------------------------------------------------------------- check 3 --
console.log("\n3. Who moved the date");
{
  const rows = (kind) => [
    c("1", 100, "2026-10-10", "INITIAL", "2026-10-01"),
    c("2", 100, "2026-10-17", kind, "2026-10-07"),
  ];
  const receipts = [r("2026-10-17", 100)];

  const supplier = resolveCommitments(rows("SUPPLIER_REVISION"), receipts, 100);
  const sScore = scoreOnTime(supplier.baseline, receipts, "2026-10-31");
  ok("a supplier slipping its own date scores 0", onTimePercent(sScore), 0);
  ok("by 7 days", averageDelay(sScore), 7);
  ok("while the revised date is still shown",
    supplier.revised, [{ date: "2026-10-17", qty: 100 }]);

  const buyer = resolveCommitments(rows("BUYER_AGREED"), receipts, 100);
  ok("a change we agreed to moves the baseline",
    buyer.baseline, [{ date: "2026-10-17", qty: 100 }]);
  ok("and scores 100", onTimePercent(scoreOnTime(buyer.baseline, receipts, "2026-10-31")), 100);
}

// ---------------------------------------------------------------- check 4 --
console.log("\n4. Due, not yet due, and never arrived");
{
  const b = [{ date: "2026-11-05", qty: 50 }];
  const notYet = scoreOnTime(b, [], "2026-10-31");
  ok("a commitment after the cutoff is not judged", onTimePercent(notYet), null);
  ok("it sits in notYetDue", notYet.notYetDue, 50);

  const overdue = scoreOnTime([{ date: "2026-10-10", qty: 50 }], [], "2026-10-31");
  ok("overdue and unreceived scores 0", onTimePercent(overdue), 0);
  ok("and is outstanding, not missing", overdue.outstanding, 50);

  // The cutoff must hold: goods that turned up in November cannot improve
  // October's number when October is re-run.
  const after = scoreOnTime(
    [{ date: "2026-10-10", qty: 50 }], [r("2026-11-02", 50)], "2026-10-31");
  ok("a later receipt is invisible to an earlier period", onTimePercent(after), 0);
}

console.log("\nMatching order, and adding up");
{
  // Owed 40 on the 10th and 60 on the 20th; 50 arrive on the 9th. The first
  // commitment is met and the second is part-filled early — not 50 credited
  // against whichever bucket flatters the supplier.
  const s = scoreOnTime(
    [{ date: "2026-10-10", qty: 40 }, { date: "2026-10-20", qty: 60 }],
    [r("2026-10-09", 50)], "2026-10-31");
  ok("earliest commitment filled first", s.onTime, 50);
  ok("the rest is outstanding", s.outstanding, 50);
  ok("nothing is late", s.late, 0);

  const t = totalOnTime([
    scoreOnTime([{ date: "2026-10-10", qty: 100 }], [r("2026-10-10", 100)], "2026-10-31"),
    scoreOnTime([{ date: "2026-10-10", qty: 100 }], [r("2026-10-20", 100)], "2026-10-31"),
  ]);
  ok("two lines, one figure", onTimePercent(t), 50);
}

console.log("\nNo commitment, no score");
{
  const none = resolveCommitments([], [r("2026-10-10", 100)], 100);
  ok("a line nobody confirmed has no baseline", none.baseline, []);
  ok("and is left out of the cohort rather than scored 0",
    onTimePercent(scoreOnTime(none.baseline, [r("2026-10-10", 100)], "2026-10-31")), null);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
