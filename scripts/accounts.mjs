// Which account a posting lands in is the chart's business, not a test's.
//
// Every suite used to assert on demo-seed codes ("1300" for inventory, "4100"
// for revenue), so loading a real chart of accounts turned a passing suite
// red without a single posting having changed. These ask the same resolvers
// lib/posting.ts asks, so an assertion says "revenue", not "4100".
//
//   const acct = accountsFor(sql, companyId);
//   await acct.forItem("REVENUE", itemId)   -> account code
//   await acct.control("AR_CONTROL", partnerId)
//   await acct.role("GRIR_CLEARING")

export function accountsFor(sql, companyId) {
  const code = async (idQuery) => {
    const [row] = await idQuery;
    if (!row?.code) throw new Error("no account resolved");
    return row.code;
  };
  return {
    forItem: (purpose, itemId, locationId = null) => code(sql`
      select code from account
       where id = fn_resolve_account_for_item(
         ${companyId}, ${purpose}, ${itemId}, null, ${locationId})`),
    control: (role, partnerId) => code(sql`
      select code from account
       where id = fn_resolve_control_account(${companyId}, ${role}, ${partnerId})`),
    role: (name) => code(sql`
      select a.code from system_account sa join account a on a.id = sa.account_id
       where sa.company_id = ${companyId} and sa.role = ${name}`),
  };
}
