import { createPartner } from "@/lib/actions";
import { SimpleForm } from "@/components/simple-form";
import { HelpHint } from "@/components/help-hint";
import { REGION_GROUPS } from "@/lib/regions";

export default function NewPartner() {
  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>New business partner</h1>
        <HelpHint>
          A partner can be a customer, a supplier, or both — here the same company
          often is.
        </HelpHint>
      </div>

      <SimpleForm action={createPartner} submitLabel="Save partner">
        <div className="card">
          <div className="card-head"><h2>Identity</h2></div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="code">Code</label>
                <input id="code" name="code" type="text" placeholder="C-005" required />
                <span className="hint">Unique, used on every document</span>
              </div>
              <div className="field">
                <label htmlFor="name">Name</label>
                <input id="name" name="name" type="text" placeholder="Golden Land Superstore" required />
              </div>
              <div className="field">
                <label htmlFor="name_my">Name (Burmese)</label>
                <input id="name_my" name="name_my" type="text" placeholder="မြန်မာလို အမည်" />
                <span className="hint">Unicode only</span>
              </div>
              <div className="field">
                <label htmlFor="company_name">Registered company</label>
                <input id="company_name" name="company_name" type="text" />
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Role</h2></div>
          <div className="card-body">
            <div className="row">
              <label className="check" htmlFor="is_customer">
                <input id="is_customer" name="is_customer" type="checkbox" defaultChecked />
                Customer — we sell to them
              </label>
              <label className="check" htmlFor="is_supplier">
                <input id="is_supplier" name="is_supplier" type="checkbox" />
                Supplier — we buy from them
              </label>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Terms and contact</h2></div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="payment_terms_days">Payment terms (days)</label>
                <input id="payment_terms_days" name="payment_terms_days" type="number" min="0" defaultValue={30} />
                <span className="hint">Sets the due date on invoices</span>
              </div>
              <div className="field">
                <label htmlFor="credit_limit">Credit limit</label>
                <input id="credit_limit" name="credit_limit" type="number" min="0" step="any" />
                <span className="hint">
                  What they may owe at once. Blank means no limit; 0 means cash only.
                  Checked on every credit sale.
                </span>
              </div>
              {/* Region groups for reporting; township stays the address
                  line it has always been. Two different jobs, which is why
                  one is a fixed list and the other is free text. */}
              <div className="field">
                <label htmlFor="region">Region / State</label>
                <select id="region" name="region" defaultValue="">
                  <option value="">Not set</option>
                  {REGION_GROUPS.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.options.map((r) => <option key={r} value={r}>{r}</option>)}
                    </optgroup>
                  ))}
                </select>
                <span className="hint">Groups revenue on the dashboard</span>
              </div>
              <div className="field">
                <label htmlFor="township">Township</label>
                <input id="township" name="township" type="text" placeholder="Bahan" />
              </div>
              <div className="field">
                <label htmlFor="phone">Phone</label>
                <input id="phone" name="phone" type="text" placeholder="09-..." />
              </div>
            </div>
            <div className="field" style={{ marginTop: "1rem" }}>
              <label htmlFor="address">Address</label>
              <input id="address" name="address" type="text" />
            </div>
          </div>
        </div>
      </SimpleForm>
    </>
  );
}
