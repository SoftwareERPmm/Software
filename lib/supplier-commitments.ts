/**
 * Turning what a supplier said into what they owed, and when.
 *
 * purchase_confirmation stores a conversation: a hundred on the tenth, then
 * forty of those on the seventeenth, then the goods. On-time delivery needs
 * that conversation resolved into a schedule of quantities and dates, and
 * then receipts matched against it. Every judgement call in that resolution
 * changes the score, so they are all here, in one file, without a database
 * underneath them — the arithmetic can be tested against numbers worked out
 * by hand.
 *
 * Four decisions, and why each one falls the way it does
 * ------------------------------------------------------
 *
 * **1. A commitment covers a quantity, not a line.** Confirming a hundred
 * for the tenth and then moving forty to the seventeenth leaves sixty owed
 * on the tenth. Scoring the whole line against one date would call a
 * supplier who delivered sixty punctually and forty a week late either
 * wholly on time or wholly late, and both are wrong by forty units.
 *
 * **2. A commitment recorded too late is not a commitment.** A supplier who
 * says nothing until the goods are already in, then sends an
 * acknowledgement dated to whenever they actually arrived, would otherwise
 * post a perfect record. Two cutoffs, either of which disqualifies a row:
 * it was recorded after the date it names — a promise about a day already
 * gone — or it was recorded after the goods it covers had arrived. What is
 * left is only what was said while it could still be believed.
 *
 * **3. The original commitment is the baseline; who moved it decides
 * whether the baseline moves.** A supplier ringing to say it will be late
 * has missed the date they gave, and their revision is the evidence, not
 * the excuse — the baseline stands. A buyer agreeing to push the order back
 * has changed the deal, and holding the supplier to a date we ourselves
 * moved would measure us. Both revisions are kept and both are shown: the
 * baseline is what the supplier is scored against, the revised schedule is
 * what the warehouse plans around, and a supplier who keeps revising is
 * visible precisely because the two diverge.
 *
 * **4. Not yet due is not late.** A quantity whose committed date falls
 * after the reporting cutoff is in neither the numerator nor the
 * denominator. A quantity due before the cutoff and still not received is
 * in the denominator alone — silence is a miss, and leaving it out would
 * let a supplier improve their score by not delivering at all.
 */

export type ConfirmationKind = "INITIAL" | "SUPPLIER_REVISION" | "BUYER_AGREED";

export type ConfirmationRow = {
  id: string;
  qty: number;
  /** ISO date the supplier committed these units to. */
  confirmedDate: string;
  kind: ConfirmationKind;
  /** ISO date we were told. Orders the rows and decides eligibility. */
  recordedOn: string;
};

export type ReceiptRow = {
  /** ISO date the goods were received. */
  date: string;
  qty: number;
};

/** A quantity owed on a date. The resolved form of the conversation. */
export type Commitment = { date: string; qty: number };

export type LineCommitments = {
  /** What the supplier is scored against: originals, plus buyer-agreed moves. */
  baseline: Commitment[];
  /** What to expect in the warehouse: every eligible move applied. */
  revised: Commitment[];
  /** Rows thrown out, and why — so a missing line can be explained. */
  ignored: { id: string; reason: string }[];
  /** Whether the supplier ever moved a date themselves. */
  supplierRevisions: number;
};

const bucketsFrom = (rows: Commitment[]) =>
  rows.map((b) => ({ ...b })).sort((a, b) => a.date.localeCompare(b.date));

/**
 * Move `qty` units to `date`, taking them from the earliest dates first.
 *
 * Earliest first because a revision is normally the front of the order
 * slipping: "the first forty will be late" is the common sentence, and
 * taking them from the back would leave the baseline saying something
 * nobody said. Any surplus beyond what is scheduled is added rather than
 * dropped — a supplier confirming more than they were asked for is a data
 * problem to see, not one to silently discard.
 */
function moveQty(buckets: Commitment[], qty: number, date: string): Commitment[] {
  let left = qty;
  const out: Commitment[] = [];
  for (const b of bucketsFrom(buckets)) {
    if (left <= 0) { out.push(b); continue; }
    const take = Math.min(b.qty, left);
    left -= take;
    if (b.qty - take > 0) out.push({ date: b.date, qty: b.qty - take });
  }
  const moved = qty - Math.max(0, left);
  if (moved > 0) out.push({ date, qty: moved });
  if (left > 0) out.push({ date, qty: left });
  return merge(out);
}

/** One bucket per date, so two confirmations for the same day read as one. */
function merge(buckets: Commitment[]): Commitment[] {
  const by = new Map<string, number>();
  for (const b of buckets) if (b.qty > 0) by.set(b.date, (by.get(b.date) ?? 0) + b.qty);
  return [...by.entries()]
    .map(([date, qty]) => ({ date, qty }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The date this line was fully received, if it ever was.
 *
 * Used as the second eligibility cutoff. A confirmation recorded after this
 * is a note written about a delivery that already happened.
 */
function completionDate(receipts: ReceiptRow[], orderedQty: number): string | null {
  let running = 0;
  for (const r of [...receipts].sort((a, b) => a.date.localeCompare(b.date))) {
    running += r.qty;
    if (running >= orderedQty) return r.date;
  }
  return null;
}

/**
 * Resolve one line's confirmations into baseline and revised schedules.
 *
 * Rows are applied in the order they were recorded, because that is the
 * order the conversation happened in and a later word replaces an earlier
 * one. Ties are broken on id so two rows logged in the same instant resolve
 * the same way every time rather than by whatever the database returns.
 */
export function resolveCommitments(
  confirmations: ConfirmationRow[],
  receipts: ReceiptRow[],
  orderedQty: number,
): LineCommitments {
  const ignored: { id: string; reason: string }[] = [];
  const done = completionDate(receipts, orderedQty);

  const eligible = [...confirmations]
    .sort((a, b) => a.recordedOn.localeCompare(b.recordedOn) || a.id.localeCompare(b.id))
    .filter((c) => {
      if (c.recordedOn > c.confirmedDate) {
        ignored.push({
          id: c.id,
          reason: `Recorded ${c.recordedOn}, after the ${c.confirmedDate} it `
            + "promises — a date cannot be committed to once it has passed.",
        });
        return false;
      }
      if (done !== null && c.recordedOn > done) {
        ignored.push({
          id: c.id,
          reason: `Recorded ${c.recordedOn}, after the goods had all arrived on `
            + `${done}. A confirmation written after delivery is a note, not a promise.`,
        });
        return false;
      }
      return true;
    });

  let baseline: Commitment[] = [];
  let revised: Commitment[] = [];
  let supplierRevisions = 0;

  for (const c of eligible) {
    switch (c.kind) {
      case "INITIAL":
        baseline = merge([...baseline, { date: c.confirmedDate, qty: c.qty }]);
        revised = merge([...revised, { date: c.confirmedDate, qty: c.qty }]);
        break;
      case "BUYER_AGREED":
        // Our change, so both schedules move: there is no promise left to
        // hold them to on the original date.
        baseline = moveQty(baseline, c.qty, c.confirmedDate);
        revised = moveQty(revised, c.qty, c.confirmedDate);
        break;
      case "SUPPLIER_REVISION":
        // Their slip. The warehouse needs the new date; the scoreboard keeps
        // the old one.
        supplierRevisions += 1;
        revised = moveQty(revised, c.qty, c.confirmedDate);
        break;
    }
  }

  return { baseline, revised, ignored, supplierRevisions };
}

export type OnTimeResult = {
  /** Quantity committed to a date on or before the cutoff. */
  due: number;
  /** Of that, how much arrived by the date it was committed to. */
  onTime: number;
  /** Due, received, but after the committed date. */
  late: number;
  /** Due and still not here. Counts against, because silence is a miss. */
  outstanding: number;
  /** Committed after the cutoff: neither credited nor penalised. */
  notYetDue: number;
  /** Total days late across the late quantity, for an average delay. */
  lateDays: number;
};

const EMPTY: OnTimeResult = {
  due: 0, onTime: 0, late: 0, outstanding: 0, notYetDue: 0, lateDays: 0,
};

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

/**
 * Match receipts against a baseline schedule and count what was on time.
 *
 * Receipts are matched earliest to earliest. A supplier who owes forty on
 * the tenth and sixty on the twentieth, and ships fifty on the ninth, has
 * met the first commitment and made a start on the second — the alternative,
 * matching a shipment to whichever commitment it happens to satisfy, lets
 * an early bulk delivery paper over a missed date later.
 *
 * `cutoff` is the end of the reporting period. Everything is judged as at
 * that date and later receipts are invisible, so re-running a past month
 * gives the answer it gave then rather than one improved by what has
 * happened since.
 */
export function scoreOnTime(
  baseline: Commitment[],
  receipts: ReceiptRow[],
  cutoff: string,
): OnTimeResult {
  if (baseline.length === 0) return { ...EMPTY };

  const buckets = bucketsFrom(baseline);
  const arrivals = [...receipts]
    .filter((r) => r.date <= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ ...r }));

  const out: OnTimeResult = { ...EMPTY };
  let a = 0;

  for (const b of buckets) {
    if (b.date > cutoff) { out.notYetDue += b.qty; continue; }

    out.due += b.qty;
    let owed = b.qty;

    while (owed > 0 && a < arrivals.length) {
      const take = Math.min(owed, arrivals[a].qty);
      if (arrivals[a].date <= b.date) {
        out.onTime += take;
      } else {
        out.late += take;
        out.lateDays += take * dayDiff(arrivals[a].date, b.date);
      }
      owed -= take;
      arrivals[a].qty -= take;
      if (arrivals[a].qty <= 0) a += 1;
    }

    out.outstanding += owed;
  }

  return out;
}

/** Add up per-line results into one supplier's figure. */
export function totalOnTime(results: OnTimeResult[]): OnTimeResult {
  return results.reduce((t, r) => ({
    due: t.due + r.due,
    onTime: t.onTime + r.onTime,
    late: t.late + r.late,
    outstanding: t.outstanding + r.outstanding,
    notYetDue: t.notYetDue + r.notYetDue,
    lateDays: t.lateDays + r.lateDays,
  }), { ...EMPTY });
}

/** The percentage, or null when nothing was due and there is nothing to say. */
export function onTimePercent(r: OnTimeResult): number | null {
  return r.due > 0 ? (100 * r.onTime) / r.due : null;
}

/** Mean days late across the quantity that was late. Null when none was. */
export function averageDelay(r: OnTimeResult): number | null {
  return r.late > 0 ? r.lateDays / r.late : null;
}
