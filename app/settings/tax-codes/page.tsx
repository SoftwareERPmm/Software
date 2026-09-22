import { sql } from "@/lib/db";
import { createTaxCode, updateTaxCode, addTaxRate } from "@/lib/actions";
import { TaxCodeRow } from "@/components/tax-code-row";
import { SimpleForm } from "@/components/simple-form";
import { HelpHint } from "@/components/help-hint";

export default async function TaxCodes() {
  const [co] = await sql`select id from company order by created_at limit 1`;
  if (!co) return <div className="empty">No company found.</div>;

  const today = new Date().toISOString().slice(0, 10);

  /* Each code with the rate in force today and every rate it has carried.
     Documents are counted per rate by the date they were posted on, so the
     history says what each rate actually taxed rather than only when it
     started. */
  const codes = (await sql`
    select t.id, t.code, t.name, t.is_active,
           fn_tax_rate_on(t.id, current_date) as current,
           (select count(distinct l.document_id)::int from document_line l
             where l.tax_code_id = t.id) as documents,
           coalesce((
             select json_agg(json_build_object(
                      'rate', r.rate,
                      'validFrom', to_char(r.valid_from, 'YYYY-MM-DD'),
                      'documents', (
                        select count(distinct d.id)::int
                          from document_line l
                          join document d on d.id = l.document_id
                         where l.tax_code_id = t.id
                           and d.doc_date >= r.valid_from
                           and d.doc_date < coalesce((
                             select min(n.valid_from) from tax_rate n
                              where n.tax_code_id = t.id and n.valid_from > r.valid_from
                           ), date '9999-12-31')
                      ))
                    order by r.valid_from)
               from tax_rate r where r.tax_code_id = t.id
           ), '[]'::json) as rates
      from tax_code t
     where t.company_id = ${co.id}
     order by t.code`) as any[];

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Tax codes</h1>
        <HelpHint>
          Commercial tax, as charged on an invoice line. Tax charged on a sale
          is money held for the revenue department, so it credits{" "}
          <span className="m">7000 Commercial Tax Payable</span> and never
          revenue; tax paid on a purchase is creditable against it, so it
          debits <span className="m">1080 Input Commercial Tax</span> and is an
          asset until it is set off. Neither account is chosen per code —
          both come from the OUTPUT_TAX and INPUT_TAX roles, so every code
          posts to the same pair.
          <br /><br />
          A rate belongs to a date. When a rate changes mid-year, add the new
          one with the day it starts from rather than editing the old one:
          both are true, and an invoice dated before the change is still
          taxed the way that day was taxed. Documents already posted never
          move either way &mdash; their tax is stored on their own lines.
        </HelpHint>
      </div>

      <SimpleForm action={createTaxCode} submitLabel="Add tax code">
        <div className="row">
          <div className="field">
            <label htmlFor="code">Code</label>
            <input id="code" name="code" type="text" placeholder="CT5" required />
          </div>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" name="name" type="text" placeholder="Commercial Tax 5%" required />
          </div>
          <div className="field">
            <label htmlFor="rate">Rate %</label>
            <input id="rate" name="rate" type="number" step="any" min="0" max="100"
                   defaultValue={5} required />
            <span className="hint">0 for exempt or zero-rated goods</span>
          </div>
          <div className="field">
            <label htmlFor="valid_from">Charged from</label>
            <input id="valid_from" name="valid_from" type="date" />
            <span className="hint">Leave blank to apply to any date</span>
          </div>
        </div>
      </SimpleForm>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Tax codes</h2>
            <span className="page-sub">{codes.length}</span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th className="r">Rate today</th>
                  <th>Posts to (output / input)</th>
                  <th className="r">History</th>
                  <th className="r">Documents</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {codes.map((t) => (
                  <TaxCodeRow
                    key={t.id}
                    taxCode={t}
                    updateAction={updateTaxCode}
                    addRateAction={addTaxRate}
                    today={today}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
