import { sql } from "@/lib/db";
import { getCompany, getCashConversionCycle } from "@/lib/queries";
import { CashCycle } from "@/components/cash-cycle";
import { HelpHint } from "@/components/help-hint";

export default async function CashCyclePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const sp = await searchParams;

  // The fiscal year by default, because working capital is judged over a
  // trading year rather than a month — a quiet month reads as brilliance.
  const [fy] = (await sql`
    select to_char(start_date, 'YYYY-MM-DD') as start_date,
           to_char(end_date + 1, 'YYYY-MM-DD') as end_date
      from fiscal_year where company_id = ${company.id}
     order by start_date desc limit 1`) as unknown as
    { start_date: string; end_date: string }[];

  const from = sp.from ?? fy?.start_date ?? "2026-01-01";
  const to = sp.to ?? fy?.end_date ?? "2027-01-01";

  const cycle = await getCashConversionCycle(company.id, from, to);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Accounting</span>
        <h1>Cash conversion cycle</h1>
        <HelpHint>
          How many days a kyat spends tied up between paying for goods and
          being paid for them. It is the working capital a distributor has to
          fund out of its own pocket, expressed as days of trading.
          <br /><br />
          Lower is better. <strong>Negative is best</strong> — it means
          suppliers are funding the business: the goods are sold and collected
          before the bill for them falls due.
          <br /><br />
          Year-end closing entries are excluded. Closing a year empties
          revenue and cost of sales into retained earnings, and a cycle
          divided by zero revenue is not a large number — it is a missing one.
        </HelpHint>
      </div>

      <CashCycle
        current={cycle.current}
        previous={cycle.previous}
        trend={cycle.trend}
        currency={company.base_currency}
      />
    </>
  );
}
