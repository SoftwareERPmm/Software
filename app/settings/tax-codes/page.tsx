import { sql } from "@/lib/db";
import { createTaxCode, updateTaxCode } from "@/lib/actions";
import { TaxCodeRow } from "@/components/tax-code-row";
import { SimpleForm } from "@/components/simple-form";
import { HelpHint } from "@/components/help-hint";

export default async function TaxCodes() {
  const [co] = await sql`select id from company order by created_at limit 1`;
  if (!co) return <div className="empty">No company found.</div>;

  const codes = (await sql`
    select t.id, t.code, t.name, t.rate, t.is_active,
           (select count(distinct l.document_id)::int from document_line l
             where l.tax_code_id = t.id) as documents,
           (select a.code from account a where a.id = t.output_account_id) as out_code,
           (select a.code from account a where a.id = t.input_account_id) as in_code
      from tax_code t
     where t.company_id = ${co.id}
     order by t.rate, t.code`) as any[];

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
          Changing a rate changes what the next invoice charges and nothing
          else. The tax on a document already posted is stored on its own
          lines, so last month&rsquo;s invoices keep the rate they were raised
          at.
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
                  <th className="r">Rate</th>
                  <th>Posts to (output / input)</th>
                  <th className="r">Documents</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {codes.map((t) => (
                  <TaxCodeRow key={t.id} taxCode={t} updateAction={updateTaxCode} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
