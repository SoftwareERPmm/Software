import { getCompany, getYearEndPositions } from "@/lib/queries";
import { closeFiscalYear, reopenYear } from "@/lib/actions";
import { YearEnd } from "@/components/year-end";
import { HelpHint } from "@/components/help-hint";

export default async function YearEndPage() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const years = (await getYearEndPositions(company.id)) as unknown as
    Parameters<typeof YearEnd>[0]["years"];

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Accounting</span>
        <h1>Year end</h1>
        <HelpHint>
          A revenue account records one year&rsquo;s selling. Carried into the
          next it would make April&rsquo;s income statement open with
          March&rsquo;s sales, so at the year end every profit and loss account
          is brought to nil against retained earnings — where the result stops
          being this year&rsquo;s and becomes the company&rsquo;s.
          <br /><br />
          Closing also shuts every period in the year, and that is the point:
          emptying the accounts while leaving the year open lets somebody book
          a March invoice in June, and retained earnings is then quietly wrong
          with nothing on the face of the books to say so.
          <br /><br />
          The close is an ordinary document with a journal entry. Reopening
          voids it rather than editing anything.
        </HelpHint>
      </div>

      {years.length === 0 ? (
        <div className="empty">No fiscal years are set up.</div>
      ) : (
        <YearEnd years={years} closeAction={closeFiscalYear} reopenAction={reopenYear} />
      )}
    </>
  );
}
