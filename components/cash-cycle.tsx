import { money } from "@/lib/format";

type Cycle = {
  from: string; to: string; days: number;
  revenue: number; cogs: number;
  inventory: number; receivable: number; payable: number;
  dio: number | null; dso: number | null; dpo: number | null; ccc: number | null;
};

const day = (v: string) =>
  new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const days = (v: number | null) =>
  v === null ? "—" : `${Math.round(v)}`;

/**
 * The cycle, and the three spans it is made of.
 *
 * Each part is shown with the two figures it came from, because a reader who
 * distrusts 178 days wants to know which number produced it — and on a young
 * or lightly settled ledger the answer is usually "almost nothing has been
 * collected yet" rather than anything about the business.
 */
export function CashCycle({ cycle, currency }: { cycle: Cycle; currency: string }) {
  const c = cycle;
  const unanswerable = c.ccc === null;

  // Implausible spans usually mean a period with little settled trading, not
  // a business in trouble. Said plainly rather than left for the reader to
  // wonder about.
  const suspicious =
    (c.dso !== null && c.dso > 120) ||
    (c.dpo !== null && c.dpo > 120) ||
    (c.dio !== null && c.dio > 180);

  const parts = [
    {
      key: "dio", label: "Days inventory", value: c.dio,
      sense: "Goods sit on the shelf",
      top: "Average inventory", topV: c.inventory,
      bottom: "Cost of sales", bottomV: c.cogs,
    },
    {
      key: "dso", label: "Days receivable", value: c.dso,
      sense: "Customers take to pay",
      top: "Average receivable", topV: c.receivable,
      bottom: "Revenue", bottomV: c.revenue,
    },
    {
      key: "dpo", label: "Days payable", value: c.dpo,
      sense: "We take to pay suppliers",
      top: "Average payable", topV: c.payable,
      bottom: "Cost of sales", bottomV: c.cogs,
    },
  ];

  return (
    <>
      <section>
        <div className="card">
          <div className="card-head">
            <h2>Cash conversion cycle</h2>
            <span className="page-sub">
              {day(c.from)} to {day(c.to)} · {c.days} days
            </span>
          </div>
          <div className="card-body">
            {unanswerable ? (
              <div className="empty">
                Not enough trading in this period to work out a cycle. It needs
                revenue and cost of sales to divide by, and one of them is nil.
              </div>
            ) : (
              <>
                <div className="row">
                  <div className="field">
                    <label>Cash is tied up for</label>
                    <span className="fixedfield" style={{
                      fontSize: "1.6rem",
                      color: c.ccc! < 0 ? "var(--ok, var(--brand))" : undefined,
                    }}>
                      {days(c.ccc)} days
                    </span>
                    <span className="hint">
                      {c.ccc! < 0
                        ? "Negative — suppliers are funding the trading. Goods are sold and "
                          + "collected before their bill falls due."
                        : "Days of trading to fund between paying for goods and being paid."}
                    </span>
                  </div>
                </div>

                {/* The arithmetic, in the open. A number this consequential
                    should not have to be taken on trust. */}
                <div className="subline" style={{ marginTop: "0.6rem" }}>
                  {days(c.dio)} days inventory + {days(c.dso)} days receivable
                  − {days(c.dpo)} days payable = <strong>{days(c.ccc)} days</strong>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      {suspicious && (
        <section>
          <div className="card">
            <div className="card-body">
              <div className="hintbar caution">
                <strong>These spans look long.</strong> On a young ledger, or one
                where little has been settled, that usually means invoices and
                bills are still open rather than that money is moving slowly.
                The figures below say which.
              </div>
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>What it is made of</h2>
            <span className="page-sub">each span, and the two figures behind it</span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Span</th><th className="r">Days</th>
                  <th className="r">Balance</th><th className="r">Against</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => (
                  <tr key={p.key}>
                    <td className="wrap">
                      <strong>{p.label}</strong>
                      <div className="subline">{p.sense}</div>
                    </td>
                    <td className="r">
                      <strong>{days(p.value)}</strong>
                      {p.value === null && (
                        <div className="subline">nothing to divide by</div>
                      )}
                    </td>
                    <td className="r">
                      {money(p.topV)}
                      <div className="subline">{p.top}</div>
                    </td>
                    <td className="r">
                      {money(p.bottomV)}
                      <div className="subline">{p.bottom} · {currency}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
