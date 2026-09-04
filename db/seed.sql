-- seed.sql
-- Demo data: a Yangon FMCG distributor, with complete document chains so the
-- workflow is visible end to end. Idempotent — safe to re-run.

set client_min_messages = warning;

-- ------------------------------------------------------------- seed helper --

-- Posts a balanced journal entry from a jsonb array of lines:
--   [{"code": "1200", "amt": 1000000, "partner": "<uuid>", "loc": "<uuid>"}]
-- Positive amt is a debit, negative a credit.
create or replace function seed_post(
    p_company     uuid,
    p_entry_no    text,
    p_date        date,
    p_source_type text,
    p_source_id   uuid,
    p_memo        text,
    p_lines       jsonb
) returns uuid language plpgsql as $$
declare
    v_entry uuid;
    v_line  jsonb;
    v_no    smallint := 0;
    v_acct  uuid;
begin
    insert into journal_entry (company_id, entry_no, entry_date, fiscal_period_id,
                               source_type, source_id, memo)
    values (p_company, p_entry_no, p_date, null, p_source_type, p_source_id, p_memo)
    returning id into v_entry;

    for v_line in select * from jsonb_array_elements(p_lines) loop
        v_no := v_no + 1;

        select id into v_acct from account
         where company_id = p_company and code = v_line->>'code';

        if v_acct is null then
            raise exception 'seed: no account with code %', v_line->>'code';
        end if;

        insert into journal_line (company_id, journal_entry_id, line_no, account_id,
                                  currency, amount, exchange_rate, base_amount,
                                  partner_id, location_id)
        values (p_company, v_entry, v_no, v_acct, 'MMK',
                (v_line->>'amt')::numeric, 1, (v_line->>'amt')::numeric,
                nullif(v_line->>'partner','')::uuid,
                nullif(v_line->>'loc','')::uuid);
    end loop;

    return v_entry;
end;
$$;

-- =========================================================================

do $seed$
declare
    co        uuid;
    fy        uuid;
    ygn_wh    uuid;  mdy_wh uuid;  ygn uuid;  mdy uuid;
    u_pcs     uuid;  u_ctn  uuid;
    g_bev     uuid;  g_snk  uuid;  g_hou uuid;
    pl_whole  uuid;  pl_retail uuid;
    tax_none  uuid;

    -- partners
    c_shwe uuid; c_aung uuid; c_golden uuid; c_thiri uuid;
    s_bev  uuid; s_snk  uuid; s_hou uuid;

    -- items
    i_cola uuid; i_juice uuid; i_water uuid;
    i_chips uuid; i_peanut uuid; i_deterg uuid; i_soap uuid;

    doc uuid; doc2 uuid; je uuid;
    m   smallint;
begin

if exists (select 1 from company where code = 'SHWE') then
    raise notice 'seed already applied';
    return;
end if;

-- ------------------------------------------------------------- company ----

insert into company (code, name, name_my, base_currency, fiscal_year_start_month)
values ('SHWE', 'Shwe Yadanar Trading Co., Ltd', 'ရွှေရတနာ ကုန်သွယ်ရေး', 'MMK', 4)
returning id into co;

insert into fiscal_year (company_id, code, start_date, end_date)
values (co, '2026-27', '2026-04-01', '2027-03-31')
returning id into fy;

for m in 0..11 loop
    insert into fiscal_period (company_id, fiscal_year_id, period_no, start_date, end_date, status)
    values (co, fy, m + 1,
            (date '2026-04-01' + (m || ' month')::interval)::date,
            ((date '2026-04-01' + ((m + 1) || ' month')::interval) - interval '1 day')::date,
            'OPEN');
end loop;

-- -------------------------------------------------------------- accounts --
-- The MTK chart, the same 65 accounts scripts/load-coa.mjs loads. Kept
-- identical on purpose: the demo and the chart a real company runs on are
-- then the same shape, and a report that reads right here reads right there.

-- Sections. Not postable — they are the headings the chart is read under.
insert into account (company_id, code, name, account_type, is_postable) values
    (co, '1-CA',   'Current Assets',                      'ASSET',     false),
    (co, '1-FA',   'Non-Current Assets (Fixed Assets)',   'ASSET',     false),
    (co, '1-IA',   'Intangible Assets',                   'ASSET',     false),
    (co, '2-CL',   'Current Liabilities',                 'LIABILITY',  false),
    (co, '2-LT',   'Long-Term Liabilities',               'LIABILITY',  false),
    (co, '3-EQ',   'Owner Equity',                        'EQUITY',    false),
    (co, '4-SA',   'Sales',                               'REVENUE',   false),
    (co, '5-CG',   'Cost of Good Sold',                   'COGS',      false),
    (co, '6-EX',   'Expense',                             'EXPENSE',   false),
    (co, '7-TX',   'Tax Account',                         'LIABILITY',  false);

-- Two sections sit under Expense rather than beside it.
insert into account (company_id, parent_id, code, name, account_type, is_postable)
select co, p.id, x.code, x.name, x.atype, false
from (values
    ('6-EX', '6-GA', 'General & Administration Expenses',   'EXPENSE'::account_type),
    ('6-EX', '6-SD', 'Selling & Distribution Expenses',     'EXPENSE'::account_type)
) as x(parent, code, name, atype)
join account p on p.company_id = co and p.code = x.parent;

-- Postable accounts, each under the section it follows in the chart.
insert into account (company_id, parent_id, code, name, account_type,
                     is_control, is_cash_account, is_bank_account)
select co, p.id, x.code, x.name, x.atype, x.ctrl, x.cash, x.bank
from (values
    ('1-CA', '1000', 'Cash on Hand',                        'ASSET'::account_type,   false,  true,   false),
    ('1-CA', '1010', 'Cash at Bank',                        'ASSET'::account_type,   false,  true,   true),
    ('1-CA', '1020', 'Petty Cash',                          'ASSET'::account_type,   false,  true,   false),
    ('1-CA', '1030', 'Accounts Receivable',                 'ASSET'::account_type,   true,   false,  false),
    ('1-CA', '1040', 'Inventory',                           'ASSET'::account_type,   false,  false,  false),
    ('1-CA', '1050', 'Prepaid Expenses',                    'ASSET'::account_type,   false,  false,  false),
    ('1-CA', '1060', 'GR/IR Clearing',                      'ASSET'::account_type,   false,  false,  false),
    ('1-FA', '1100', 'Land',                                'ASSET'::account_type,   false,  false,  false),
    ('1-FA', '1110', 'Building',                            'ASSET'::account_type,   false,  false,  false),
    ('1-FA', '1120', 'Office Equipment',                    'ASSET'::account_type,   false,  false,  false),
    ('1-FA', '1130', 'Furniture & Fixtures',                'ASSET'::account_type,   false,  false,  false),
    ('1-FA', '1140', 'Vehicle',                             'ASSET'::account_type,   false,  false,  false),
    ('1-FA', '1190', 'Accumulated Depreciation',            'ASSET'::account_type,   false,  false,  false),
    ('1-IA', '1200', 'Software',                            'ASSET'::account_type,   false,  false,  false),
    ('1-IA', '1210', 'Accumulated Amortization',            'ASSET'::account_type,   false,  false,  false),
    ('2-CL', '2000', 'Accounts Payable',                    'LIABILITY'::account_type,  true,   false,  false),
    ('2-CL', '2010', 'Salary Payable',                      'LIABILITY'::account_type,  false,  false,  false),
    ('2-CL', '2020', 'Tax Payable',                         'LIABILITY'::account_type,  false,  false,  false),
    ('2-CL', '2030', 'Accrued Expenses',                    'LIABILITY'::account_type,  false,  false,  false),
    ('2-LT', '2040', 'Loan Payable – Short Term',           'LIABILITY'::account_type,  false,  false,  false),
    ('2-LT', '2050', 'Loan Payable – Long Term',            'LIABILITY'::account_type,  false,  false,  false),
    ('3-EQ', '3000', 'Owner''s Capital',                    'EQUITY'::account_type,  false,  false,  false),
    ('3-EQ', '3010', 'Owner''s Drawing',                    'EQUITY'::account_type,  false,  false,  false),
    ('3-EQ', '3020', 'Retained Earnings',                   'EQUITY'::account_type,  false,  false,  false),
    ('3-EQ', '3030', 'Opening Balance Equity',              'EQUITY'::account_type,  false,  false,  false),
    ('4-SA', '4000', 'Sales',                               'REVENUE'::account_type,  false,  false,  false),
    ('4-SA', '4010', 'Sales Return',                        'REVENUE'::account_type,  false,  false,  false),
    ('4-SA', '4020', 'Sales Discount',                      'REVENUE'::account_type,  false,  false,  false),
    ('4-SA', '4100', 'Other Income',                        'REVENUE'::account_type,  false,  false,  false),
    ('5-CG', '5000', 'Purchase',                            'COGS'::account_type,    false,  false,  false),
    ('5-CG', '5010', 'Purchase Return',                     'COGS'::account_type,    false,  false,  false),
    ('5-CG', '5020', 'Purchase Discounts',                  'COGS'::account_type,    false,  false,  false),
    ('5-CG', '5030', 'Carriage Inward',                     'COGS'::account_type,    false,  false,  false),
    ('5-CG', '5050', 'Purchase Price Variance',             'COGS'::account_type,    false,  false,  false),
    ('5-CG', '5300', 'Inventory Adjustment',                'COGS'::account_type,    false,  false,  false),
    ('6-GA', '6000', 'Salary',                              'EXPENSE'::account_type,  false,  false,  false),
    ('6-GA', '6010', 'Rent',                                'EXPENSE'::account_type,  false,  false,  false),
    ('6-GA', '6020', 'Utilities – Electricity & Water',     'EXPENSE'::account_type,  false,  false,  false),
    ('6-GA', '6030', 'Transportation & Delivery Expense',   'EXPENSE'::account_type,  false,  false,  false),
    ('6-GA', '6060', 'Internet & Phone Bill',               'EXPENSE'::account_type,  false,  false,  false),
    ('6-GA', '6070', 'Repairs & Maintenance',               'EXPENSE'::account_type,  false,  false,  false),
    ('6-GA', '6080', 'Printing & Stationery',               'EXPENSE'::account_type,  false,  false,  false),
    ('6-GA', '6090', 'Office Supplies',                     'EXPENSE'::account_type,  false,  false,  false),
    ('6-GA', '6100', 'Bank Charges',                        'EXPENSE'::account_type,  false,  false,  false),
    ('6-GA', '6110', 'Miscellaneous Expenses',              'EXPENSE'::account_type,  false,  false,  false),
    ('6-GA', '6160', 'Depreciation Expense',                'EXPENSE'::account_type,  false,  false,  false),
    ('6-SD', '6300', 'Discount Allowed',                    'EXPENSE'::account_type,  false,  false,  false),
    ('6-SD', '6310', 'Advertising Expense',                 'EXPENSE'::account_type,  false,  false,  false),
    ('6-SD', '6320', 'Promotion Expense',                   'EXPENSE'::account_type,  false,  false,  false),
    ('6-SD', '6330', 'Commission Expenses',                 'EXPENSE'::account_type,  false,  false,  false),
    ('6-SD', '6340', 'Delivery Charges',                    'EXPENSE'::account_type,  false,  false,  false),
    ('7-TX', '7000', 'Commercial Tax Payable',              'LIABILITY'::account_type,  false,  false,  false),
    ('7-TX', '7010', 'Income Tax Payable',                  'LIABILITY'::account_type,  false,  false,  false)
) as x(parent, code, name, atype, ctrl, cash, bank)
join account p on p.company_id = co and p.code = x.parent;

insert into system_account (company_id, role, account_id)
select co, r.role, a.id
from (values
    ('GRIR_CLEARING',               '1060'),
    ('OPENING_BALANCE_EQUITY',      '3030'),
    ('RETAINED_EARNINGS',           '3020'),
    ('PURCHASE_PRICE_VARIANCE',     '5050'),
    ('PURCHASE_DISCOUNT_RECEIVED',  '5020'),
    ('SALES_DISCOUNT_ALLOWED',      '6300'),
    ('PROMOTION_EXPENSE',           '6320'),
    ('STOCK_ADJUSTMENT',            '5300'),
    ('FX_GAIN',                     '4100'),
    ('FX_LOSS',                     '6110'),
    ('ROUNDING_DIFFERENCE',         '6110'),
    ('DELIVERY_INCOME',             '4100')
) as r(role, code)
join account a on a.company_id = co and a.code = r.code;

-- ------------------------------------------------------------- locations --

insert into location (company_id, code, name, name_my, is_stock_location)
values (co, 'YGN', 'Yangon Branch', 'ရန်ကုန်', false) returning id into ygn;
insert into location (company_id, parent_id, code, name, is_stock_location)
values (co, ygn, 'YGN-WH', 'Yangon Main Warehouse', true) returning id into ygn_wh;

insert into location (company_id, code, name, name_my, is_stock_location)
values (co, 'MDY', 'Mandalay Branch', 'မန္တလေး', false) returning id into mdy;
insert into location (company_id, parent_id, code, name, is_stock_location)
values (co, mdy, 'MDY-WH', 'Mandalay Warehouse', true) returning id into mdy_wh;

-- --------------------------------------------------- units, groups, items --

insert into uom (company_id, code, name) values (co, 'PCS', 'Pieces') returning id into u_pcs;
insert into uom (company_id, code, name) values (co, 'CTN', 'Carton')  returning id into u_ctn;

-- Segments compose into the full code: 01, 02, 03 at the top level.
insert into item_group (company_id, segment, code, name, name_my)
values (co, '01', 'x', 'Beverages', 'အအေးများ') returning id into g_bev;
insert into item_group (company_id, segment, code, name, name_my)
values (co, '02', 'x', 'Snacks', 'မုန့်များ') returning id into g_snk;
insert into item_group (company_id, segment, code, name, name_my)
values (co, '03', 'x', 'Household', 'အိမ်သုံး') returning id into g_hou;

insert into item (company_id, item_group_id, serial, code, name, name_my, base_uom_id) values
    (co, g_bev, '001', 'x', 'Cola 330ml Can', 'ကိုလာ ၃၃၀ml', u_pcs) returning id into i_cola;
insert into item (company_id, item_group_id, serial, code, name, base_uom_id) values
    (co, g_bev, '002', 'x', 'Orange Juice 1L', u_pcs) returning id into i_juice;
insert into item (company_id, item_group_id, serial, code, name, base_uom_id) values
    (co, g_bev, '003', 'x', 'Drinking Water 500ml', u_pcs) returning id into i_water;
insert into item (company_id, item_group_id, serial, code, name, base_uom_id) values
    (co, g_snk, '001', 'x', 'Potato Chips 45g', u_pcs) returning id into i_chips;
insert into item (company_id, item_group_id, serial, code, name, base_uom_id) values
    (co, g_snk, '002', 'x', 'Peanut Snack 60g', u_pcs) returning id into i_peanut;
insert into item (company_id, item_group_id, serial, code, name, base_uom_id) values
    (co, g_hou, '001', 'x', 'Laundry Detergent 1kg', u_pcs) returning id into i_deterg;
insert into item (company_id, item_group_id, serial, code, name, base_uom_id) values
    (co, g_hou, '002', 'x', 'Dish Soap 500ml', u_pcs) returning id into i_soap;

-- Carton conversions: the three-tier unit hierarchy in practice.
insert into item_uom (company_id, item_id, uom_id, factor) values
    (co, i_cola, u_ctn, 24), (co, i_water, u_ctn, 24), (co, i_chips, u_ctn, 60);

insert into price_level (company_id, code, name, sort_order)
values (co, 'WHOLE', 'Wholesale', 1) returning id into pl_whole;
insert into price_level (company_id, code, name, sort_order)
values (co, 'RETAIL', 'Retail', 2) returning id into pl_retail;

insert into item_price (company_id, item_id, price_level_id, uom_id, currency, price)
select co, x.item, pl_whole, u_pcs, 'MMK', x.price from (values
    (i_cola, 1000), (i_juice, 2800), (i_water, 350), (i_chips, 800),
    (i_peanut, 600), (i_deterg, 4500), (i_soap, 2400)
) as x(item, price);

-- Tax engine deferred; the shape is reserved. Every line points here for now.
insert into tax_code (company_id, code, name, rate)
values (co, 'NONE', 'No Commercial Tax', 0) returning id into tax_none;

-- ---------------------------------------------------- account determination --

insert into account_determination (company_id, role, item_group_id, account_id)
select co, r.role, null, a.id
from (values
    ('AR_CONTROL',                  '1030'),
    ('AP_CONTROL',                  '2000'),
    ('INVENTORY',                   '1040'),
    ('COGS',                        '5000'),
    ('REVENUE',                     '4000'),
    ('SALES_RETURN',                '4010')
) as r(role, code)
join account a on a.company_id = co and a.code = r.code;

-- ------------------------------------------------------------- partners --

insert into business_partner (company_id, code, name, name_my, is_customer, township, payment_terms_days, price_level_id)
values (co, 'C-001', 'Shwe Yaung Ni Trading', 'ရွှေရောင်နီ', true, 'Lanmadaw', 30, pl_whole) returning id into c_shwe;
insert into business_partner (company_id, code, name, is_customer, township, payment_terms_days, price_level_id)
values (co, 'C-002', 'Aung Mingalar Mini Mart', true, 'Hlaing', 15, pl_whole) returning id into c_aung;
insert into business_partner (company_id, code, name, is_customer, township, payment_terms_days, price_level_id)
values (co, 'C-003', 'Golden Land Superstore', true, 'Bahan', 45, pl_whole) returning id into c_golden;
insert into business_partner (company_id, code, name, is_customer, township, payment_terms_days, price_level_id)
values (co, 'C-004', 'Thiri Retail (Mandalay)', true, 'Chanayethazan', 30, pl_whole) returning id into c_thiri;

insert into business_partner (company_id, code, name, is_supplier, payment_terms_days)
values (co, 'S-001', 'Myanmar Beverage Industries', true, 30) returning id into s_bev;
insert into business_partner (company_id, code, name, is_supplier, payment_terms_days)
values (co, 'S-002', 'Asia Snack Manufacturing', true, 30) returning id into s_snk;
insert into business_partner (company_id, code, name, is_supplier, payment_terms_days)
values (co, 'S-003', 'Yangon Household Goods', true, 45) returning id into s_hou;

-- ------------------------------------------------------------- salesmen --

insert into salesman (company_id, code, name, name_my, location_id, commission_pct) values
    (co, 'SM-01', 'Ko Myat Thu',  'ကိုမြတ်သူ',  ygn_wh, 2),
    (co, 'SM-02', 'Ma Thida Win', 'မသီတာဝင်း', ygn_wh, 2),
    (co, 'SM-03', 'Ko Zaw Lin',   null,         mdy_wh, 1.5),
    (co, 'SM-04', 'Counter Sale', null,         ygn_wh, 0);

-- ----------------------------------------------------------- promotions --

insert into promotion (company_id, code, name, discount_pct, valid_from) values
    (co, 'PROMO-THINGYAN', 'Thingyan 5% off',   5, '2026-04-01'),
    (co, 'PROMO-BULK',     'Bulk order 3% off', 3, '2026-04-01');

insert into promotion (company_id, code, name, item_group_id, buy_qty, free_qty, valid_from)
values (co, 'PROMO-B10G1', 'Buy 10 get 1 free', g_bev, 10, 1, '2026-04-01');

-- Cash and bank flags come with the chart above (1000 Cash on Hand, 1010
-- Cash at Bank, 1020 Petty Cash), so there is nothing to set here. On the
-- old chart this update named 1110 and 1120 — which on this one are Building
-- and Office Equipment, and would have offered a fixed asset as a till.

-- Free-of-charge reasons. Stock still leaves, but the cost lands in expense
-- rather than COGS, so a giveaway is visible instead of quietly eroding
-- gross margin.
insert into foc_reason (company_id, code, name, name_my, account_id)
select co, r.code, r.name, r.name_my, a.id
from (values
    ('PROMOTION', 'Promotional giveaway', 'ကြော်ငြာအတွက်', '6320'),
    ('SAMPLE',    'Customer sample',      null,            '6320'),
    ('OFFICE',    'Office use',           null,            '6320'),
    ('DAMAGED',   'Damaged or expired',   null,            '5300')
) as r(code, name, name_my, acct)
join account a on a.company_id = co and a.code = r.acct;

-- ------------------------------------------------------- numbering series --

insert into number_series (company_id, document_type, fiscal_year_id, prefix, next_value)
select co, t.dt, fy, t.px, t.nv from (values
    ('PURCHASE_ORDER','PO-',3), ('GOODS_RECEIPT','GR-',4), ('PURCHASE_INVOICE','PI-',3),
    ('SUPPLIER_PAYMENT','PAY-',2), ('SALES_ORDER','SO-',5), ('DELIVERY','DO-',5),
    ('SALES_INVOICE','SI-',5), ('CUSTOMER_RECEIPT','RC-',3),
    ('PURCHASE_RETURN','PR-',1), ('SALES_RETURN','SR-',1),
    ('STOCK_ADJUSTMENT','ADJ-',1), ('STOCK_TRANSFER','TRF-',1), ('OPENING_BALANCE','OB-',2),
    ('CASH_VOUCHER','CV-',1), ('BANK_VOUCHER','BV-',1),
    ('JOURNAL_VOUCHER','JV-',1), ('CASH_TRANSFER','CT-',1), ('JOURNAL','JE-',1)
) as t(dt, px, nv);

-- =========================== DOCUMENTS ====================================
-- Opening capital, then complete purchase and sales chains.

-- Opening capital injection.
insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      currency, status, net_total, gross_total, memo, posted_at)
values (co, 'OPENING_BALANCE', 'OB-000001', fy, '2026-04-01', '2026-04-01',
        'MMK', 'POSTED', 50000000, 50000000, 'Opening capital', now())
returning id into doc;
je := seed_post(co, 'JE-000001', '2026-04-01', 'OPENING_BALANCE', doc, 'Opening capital',
      jsonb_build_array(
        jsonb_build_object('code','1010','amt', 50000000),
        jsonb_build_object('code','3000','amt',-50000000)));
update document set journal_entry_id = je where id = doc;

-- ---- PURCHASE CHAIN 1 (complete): PO -> GR -> PI -> Payment --------------

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, location_id, currency, status, net_total, gross_total, posted_at)
values (co, 'PURCHASE_ORDER', 'PO-000001', fy, '2026-07-02', '2026-07-02',
        s_bev, ygn_wh, 'MMK', 'POSTED', 8500000, 8500000, now())
returning id into doc;
insert into document_line (company_id, document_id, line_no, item_id, location_id,
                           entered_qty, entered_uom_id, base_qty, unit_price,
                           net_amount, tax_code_id, gross_amount)
values (co, doc, 1, i_cola,  ygn_wh, 5000, u_pcs, 5000, 850, 4250000, tax_none, 4250000),
       (co, doc, 2, i_water, ygn_wh,10000, u_pcs,10000, 250, 2500000, tax_none, 2500000),
       (co, doc, 3, i_juice, ygn_wh,  800, u_pcs,  800,2200, 1760000, tax_none, 1760000);
doc2 := doc;

-- Goods receipt against that PO.
insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, location_id, currency, status, source_document_id,
                      net_total, gross_total, posted_at)
values (co, 'GOODS_RECEIPT', 'GR-000001', fy, '2026-07-10', '2026-07-10',
        s_bev, ygn_wh, 'MMK', 'POSTED', doc2, 8510000, 8510000, now())
returning id into doc;
insert into document_line (company_id, document_id, line_no, item_id, location_id,
                           entered_qty, entered_uom_id, base_qty, unit_price,
                           net_amount, tax_code_id, gross_amount)
values (co, doc, 1, i_cola,  ygn_wh, 5000, u_pcs, 5000, 850, 4250000, tax_none, 4250000),
       (co, doc, 2, i_water, ygn_wh,10000, u_pcs,10000, 250, 2500000, tax_none, 2500000),
       (co, doc, 3, i_juice, ygn_wh,  800, u_pcs,  800,2200, 1760000, tax_none, 1760000);

insert into stock_movement (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
values (co, i_cola,  ygn_wh, '2026-07-10',  5000,  850, 4250000, doc),
       (co, i_water, ygn_wh, '2026-07-10', 10000,  250, 2500000, doc),
       (co, i_juice, ygn_wh, '2026-07-10',   800, 2200, 1760000, doc);

je := seed_post(co, 'JE-000002', '2026-07-10', 'GOODS_RECEIPT', doc, 'GR-000001 from Myanmar Beverage',
      jsonb_build_array(
        jsonb_build_object('code','1040','amt', 8510000,'loc',ygn_wh),
        jsonb_build_object('code','1060','amt',-8510000)));
update document set journal_entry_id = je where id = doc;

-- Supplier invoice: billed 8,530,000 against a 8,510,000 receipt.
-- The 20,000 difference lands in Purchase Price Variance (decision D1).
insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date, due_date,
                      partner_id, currency, status, source_document_id,
                      net_total, gross_total, posted_at)
values (co, 'PURCHASE_INVOICE', 'PI-000001', fy, '2026-07-12', '2026-07-12', '2026-08-11',
        s_bev, 'MMK', 'POSTED', doc, 8530000, 8530000, now())
returning id into doc;
je := seed_post(co, 'JE-000003', '2026-07-12', 'PURCHASE_INVOICE', doc, 'PI-000001',
      jsonb_build_array(
        jsonb_build_object('code','1060','amt', 8510000),
        jsonb_build_object('code','5050','amt',   20000),
        jsonb_build_object('code','2000','amt',-8530000,'partner',s_bev)));
update document set journal_entry_id = je where id = doc;
doc2 := doc;

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, currency, status, net_total, gross_total, posted_at)
values (co, 'SUPPLIER_PAYMENT', 'PAY-000001', fy, '2026-08-05', '2026-08-05',
        s_bev, 'MMK', 'POSTED', 8530000, 8530000, now())
returning id into doc;
insert into payment_allocation (company_id, payment_id, invoice_id, amount, base_amount)
values (co, doc, doc2, 8530000, 8530000);
je := seed_post(co, 'JE-000004', '2026-08-05', 'SUPPLIER_PAYMENT', doc, 'PAY-000001 settling PI-000001',
      jsonb_build_array(
        jsonb_build_object('code','2000','amt', 8530000,'partner',s_bev),
        jsonb_build_object('code','1010','amt',-8530000)));
update document set journal_entry_id = je where id = doc;

-- ---- PURCHASE CHAIN 2 (goods in, invoice not yet received) ---------------
-- Leaves a balance in GR/IR — the working report that flags missing bills.

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, location_id, currency, status,
                      net_total, gross_total, posted_at)
values (co, 'GOODS_RECEIPT', 'GR-000002', fy, '2026-08-03', '2026-08-03',
        s_snk, ygn_wh, 'MMK', 'POSTED', 3300000, 3300000, now())
returning id into doc;
insert into document_line (company_id, document_id, line_no, item_id, location_id,
                           entered_qty, entered_uom_id, base_qty, unit_price,
                           net_amount, tax_code_id, gross_amount)
values (co, doc, 1, i_chips,  ygn_wh, 4000, u_pcs, 4000, 600, 2400000, tax_none, 2400000),
       (co, doc, 2, i_peanut, ygn_wh, 2000, u_pcs, 2000, 450,  900000, tax_none,  900000);
insert into stock_movement (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
values (co, i_chips,  ygn_wh, '2026-08-03', 4000, 600, 2400000, doc),
       (co, i_peanut, ygn_wh, '2026-08-03', 2000, 450,  900000, doc);
je := seed_post(co, 'JE-000005', '2026-08-03', 'GOODS_RECEIPT', doc, 'GR-000002 — supplier invoice outstanding',
      jsonb_build_array(
        jsonb_build_object('code','1040','amt', 3300000,'loc',ygn_wh),
        jsonb_build_object('code','1060','amt',-3300000)));
update document set journal_entry_id = je where id = doc;

-- Household goods, invoiced and paid.
insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, location_id, currency, status,
                      net_total, gross_total, posted_at)
values (co, 'GOODS_RECEIPT', 'GR-000003', fy, '2026-07-20', '2026-07-20',
        s_hou, ygn_wh, 'MMK', 'POSTED', 6100000, 6100000, now())
returning id into doc;
insert into document_line (company_id, document_id, line_no, item_id, location_id,
                           entered_qty, entered_uom_id, base_qty, unit_price,
                           net_amount, tax_code_id, gross_amount)
values (co, doc, 1, i_deterg, ygn_wh, 1000, u_pcs, 1000, 3500, 3500000, tax_none, 3500000),
       (co, doc, 2, i_soap,   ygn_wh, 1500, u_pcs, 1500, 1800, 2700000, tax_none, 2700000);
insert into stock_movement (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
values (co, i_deterg, ygn_wh, '2026-07-20', 1000, 3500, 3500000, doc),
       (co, i_soap,   ygn_wh, '2026-07-20', 1500, 1800, 2700000, doc);
je := seed_post(co, 'JE-000006', '2026-07-20', 'GOODS_RECEIPT', doc, 'GR-000003',
      jsonb_build_array(
        jsonb_build_object('code','1040','amt', 6200000,'loc',ygn_wh),
        jsonb_build_object('code','1060','amt',-6200000)));
update document set journal_entry_id = je where id = doc;

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date, due_date,
                      partner_id, currency, status, source_document_id, net_total, gross_total, posted_at)
values (co, 'PURCHASE_INVOICE', 'PI-000002', fy, '2026-07-22', '2026-07-22', '2026-09-05',
        s_hou, 'MMK', 'POSTED', doc, 6200000, 6200000, now())
returning id into doc;
je := seed_post(co, 'JE-000007', '2026-07-22', 'PURCHASE_INVOICE', doc, 'PI-000002',
      jsonb_build_array(
        jsonb_build_object('code','1060','amt', 6200000),
        jsonb_build_object('code','2000','amt',-6200000,'partner',s_hou)));
update document set journal_entry_id = je where id = doc;

-- ---- SALES CHAIN 1 (complete): SO -> Delivery -> Invoice -> Receipt ------

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, location_id, currency, status, net_total, gross_total, posted_at)
values (co, 'SALES_ORDER', 'SO-000001', fy, '2026-07-25', '2026-07-25',
        c_shwe, ygn_wh, 'MMK', 'POSTED', 3400000, 3400000, now())
returning id into doc;
insert into document_line (company_id, document_id, line_no, item_id, location_id,
                           entered_qty, entered_uom_id, base_qty, unit_price,
                           net_amount, tax_code_id, gross_amount)
values (co, doc, 1, i_cola,  ygn_wh, 2000, u_pcs, 2000, 1000, 2000000, tax_none, 2000000),
       (co, doc, 2, i_water, ygn_wh, 4000, u_pcs, 4000,  350, 1400000, tax_none, 1400000);
doc2 := doc;

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, location_id, currency, status, source_document_id,
                      net_total, gross_total, posted_at)
values (co, 'DELIVERY', 'DO-000001', fy, '2026-07-28', '2026-07-28',
        c_shwe, ygn_wh, 'MMK', 'POSTED', doc2, 3400000, 3400000, now())
returning id into doc;
insert into document_line (company_id, document_id, line_no, item_id, location_id,
                           entered_qty, entered_uom_id, base_qty, unit_price,
                           net_amount, tax_code_id, gross_amount)
values (co, doc, 1, i_cola,  ygn_wh, 2000, u_pcs, 2000, 1000, 2000000, tax_none, 2000000),
       (co, doc, 2, i_water, ygn_wh, 4000, u_pcs, 4000,  350, 1400000, tax_none, 1400000);
insert into stock_movement (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
values (co, i_cola,  ygn_wh, '2026-07-28', -2000, 850, -1700000, doc),
       (co, i_water, ygn_wh, '2026-07-28', -4000, 250, -1000000, doc);
je := seed_post(co, 'JE-000008', '2026-07-28', 'DELIVERY', doc, 'DO-000001 — cost recognised',
      jsonb_build_array(
        jsonb_build_object('code','5000','amt', 2700000,'loc',ygn_wh),
        jsonb_build_object('code','1040','amt',-2700000,'loc',ygn_wh)));
update document set journal_entry_id = je where id = doc;

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date, due_date,
                      partner_id, currency, status, source_document_id, net_total, gross_total, posted_at)
values (co, 'SALES_INVOICE', 'SI-000001', fy, '2026-07-30', '2026-07-30', '2026-08-29',
        c_shwe, 'MMK', 'POSTED', doc, 3400000, 3400000, now())
returning id into doc;
je := seed_post(co, 'JE-000009', '2026-07-30', 'SALES_INVOICE', doc, 'SI-000001 — revenue recognised',
      jsonb_build_array(
        jsonb_build_object('code','1030','amt', 3400000,'partner',c_shwe),
        jsonb_build_object('code','4000','amt',-3400000)));
update document set journal_entry_id = je where id = doc;
doc2 := doc;

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, currency, status, net_total, gross_total, posted_at)
values (co, 'CUSTOMER_RECEIPT', 'RC-000001', fy, '2026-08-08', '2026-08-08',
        c_shwe, 'MMK', 'POSTED', 3400000, 3400000, now())
returning id into doc;
insert into payment_allocation (company_id, payment_id, invoice_id, amount, base_amount)
values (co, doc, doc2, 3400000, 3400000);
je := seed_post(co, 'JE-000010', '2026-08-08', 'CUSTOMER_RECEIPT', doc, 'RC-000001 settling SI-000001',
      jsonb_build_array(
        jsonb_build_object('code','1010','amt', 3400000),
        jsonb_build_object('code','1030','amt',-3400000,'partner',c_shwe)));
update document set journal_entry_id = je where id = doc;

-- ---- SALES CHAIN 2 (invoiced, overdue, partly paid) ----------------------

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, location_id, currency, status, net_total, gross_total, posted_at)
values (co, 'DELIVERY', 'DO-000002', fy, '2026-07-05', '2026-07-05',
        c_golden, ygn_wh, 'MMK', 'POSTED', 5250000, 5250000, now())
returning id into doc;
insert into document_line (company_id, document_id, line_no, item_id, location_id,
                           entered_qty, entered_uom_id, base_qty, unit_price,
                           net_amount, tax_code_id, gross_amount)
values (co, doc, 1, i_deterg, ygn_wh, 500, u_pcs, 500, 4500, 2250000, tax_none, 2250000),
       (co, doc, 2, i_soap,   ygn_wh,1250, u_pcs,1250, 2400, 3000000, tax_none, 3000000);
insert into stock_movement (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
values (co, i_deterg, ygn_wh, '2026-07-05', -500, 3500, -1750000, doc),
       (co, i_soap,   ygn_wh, '2026-07-05',-1250, 1800, -2250000, doc);
je := seed_post(co, 'JE-000011', '2026-07-05', 'DELIVERY', doc, 'DO-000002',
      jsonb_build_array(
        jsonb_build_object('code','5000','amt', 4000000,'loc',ygn_wh),
        jsonb_build_object('code','1040','amt',-4000000,'loc',ygn_wh)));
update document set journal_entry_id = je where id = doc;

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date, due_date,
                      partner_id, currency, status, source_document_id, net_total, gross_total, posted_at)
values (co, 'SALES_INVOICE', 'SI-000002', fy, '2026-07-06', '2026-07-06', '2026-07-21',
        c_golden, 'MMK', 'POSTED', doc, 5250000, 5250000, now())
returning id into doc;
je := seed_post(co, 'JE-000012', '2026-07-06', 'SALES_INVOICE', doc, 'SI-000002',
      jsonb_build_array(
        jsonb_build_object('code','1030','amt', 5250000,'partner',c_golden),
        jsonb_build_object('code','4000','amt',-5250000)));
update document set journal_entry_id = je where id = doc;
doc2 := doc;

-- Partial payment: 2,000,000 of 5,250,000. Open-item matching means the
-- remaining 3,250,000 stays attached to this specific invoice.
insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, currency, status, net_total, gross_total, posted_at)
values (co, 'CUSTOMER_RECEIPT', 'RC-000002', fy, '2026-08-01', '2026-08-01',
        c_golden, 'MMK', 'POSTED', 2000000, 2000000, now())
returning id into doc;
insert into payment_allocation (company_id, payment_id, invoice_id, amount, base_amount)
values (co, doc, doc2, 2000000, 2000000);
je := seed_post(co, 'JE-000013', '2026-08-01', 'CUSTOMER_RECEIPT', doc, 'RC-000002 part payment of SI-000002',
      jsonb_build_array(
        jsonb_build_object('code','1010','amt', 2000000),
        jsonb_build_object('code','1030','amt',-2000000,'partner',c_golden)));
update document set journal_entry_id = je where id = doc;

-- ---- SALES CHAIN 3 (invoiced, unpaid, not yet due) -----------------------

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, location_id, currency, status, net_total, gross_total, posted_at)
values (co, 'DELIVERY', 'DO-000003', fy, '2026-08-06', '2026-08-06',
        c_aung, ygn_wh, 'MMK', 'POSTED', 1560000, 1560000, now())
returning id into doc;
insert into document_line (company_id, document_id, line_no, item_id, location_id,
                           entered_qty, entered_uom_id, base_qty, unit_price,
                           net_amount, tax_code_id, gross_amount)
values (co, doc, 1, i_chips,  ygn_wh, 1200, u_pcs, 1200, 800, 960000, tax_none, 960000),
       (co, doc, 2, i_peanut, ygn_wh, 1000, u_pcs, 1000, 600, 600000, tax_none, 600000);
insert into stock_movement (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
values (co, i_chips,  ygn_wh, '2026-08-06', -1200, 600, -720000, doc),
       (co, i_peanut, ygn_wh, '2026-08-06', -1000, 450, -450000, doc);
je := seed_post(co, 'JE-000014', '2026-08-06', 'DELIVERY', doc, 'DO-000003',
      jsonb_build_array(
        jsonb_build_object('code','5000','amt', 1170000,'loc',ygn_wh),
        jsonb_build_object('code','1040','amt',-1170000,'loc',ygn_wh)));
update document set journal_entry_id = je where id = doc;

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date, due_date,
                      partner_id, currency, status, source_document_id, net_total, gross_total, posted_at)
values (co, 'SALES_INVOICE', 'SI-000003', fy, '2026-08-07', '2026-08-07', '2026-08-22',
        c_aung, 'MMK', 'POSTED', doc, 1560000, 1560000, now())
returning id into doc;
je := seed_post(co, 'JE-000015', '2026-08-07', 'SALES_INVOICE', doc, 'SI-000003',
      jsonb_build_array(
        jsonb_build_object('code','1030','amt', 1560000,'partner',c_aung),
        jsonb_build_object('code','4000','amt',-1560000)));
update document set journal_entry_id = je where id = doc;

-- ---- SALES CHAIN 4 (open order, nothing delivered) ----------------------

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, location_id, currency, status, net_total, gross_total)
values (co, 'SALES_ORDER', 'SO-000004', fy, '2026-08-11', '2026-08-11',
        c_thiri, mdy_wh, 'MMK', 'DRAFT', 2740000, 2740000)
returning id into doc;
insert into document_line (company_id, document_id, line_no, item_id, location_id,
                           entered_qty, entered_uom_id, base_qty, unit_price,
                           net_amount, tax_code_id, gross_amount)
values (co, doc, 1, i_juice,  mdy_wh, 500, u_pcs, 500, 2800, 1400000, tax_none, 1400000),
       (co, doc, 2, i_deterg, mdy_wh, 200, u_pcs, 200, 4500,  900000, tax_none,  900000),
       (co, doc, 3, i_cola,   mdy_wh, 440, u_pcs, 440, 1000,  440000, tax_none,  440000);

-- ---- Free of charge: promotion stock, cost to expense not COGS ----------

insert into document (company_id, doc_type, doc_no, fiscal_year_id, doc_date, posting_date,
                      partner_id, location_id, currency, status, net_total, gross_total, posted_at)
values (co, 'DELIVERY', 'DO-000004', fy, '2026-08-09', '2026-08-09',
        c_aung, ygn_wh, 'MMK', 'POSTED', 0, 0, now())
returning id into doc;
insert into document_line (company_id, document_id, line_no, item_id, location_id,
                           entered_qty, entered_uom_id, base_qty, unit_price,
                           net_amount, tax_code_id, gross_amount, foc_reason_id)
select co, doc, 1, i_cola, ygn_wh, 200, u_pcs, 200, 0, 0, tax_none, 0, f.id
  from foc_reason f where f.company_id = co and f.code = 'PROMOTION';
insert into stock_movement (company_id, item_id, location_id, movement_date, qty, unit_cost, total_cost, document_id)
values (co, i_cola, ygn_wh, '2026-08-09', -200, 850, -170000, doc);
je := seed_post(co, 'JE-000016', '2026-08-09', 'DELIVERY', doc, 'DO-000004 — promotional stock',
      jsonb_build_array(
        jsonb_build_object('code','6320','amt', 170000,'loc',ygn_wh),
        jsonb_build_object('code','1040','amt',-170000,'loc',ygn_wh)));
update document set journal_entry_id = je where id = doc;

-- ---- Operating expenses -------------------------------------------------

je := seed_post(co, 'JE-000017', '2026-07-31', null, null, 'July salaries',
      jsonb_build_array(
        jsonb_build_object('code','6000','amt', 4200000),
        jsonb_build_object('code','1010','amt',-4200000)));
je := seed_post(co, 'JE-000018', '2026-07-31', null, null, 'July warehouse rent',
      jsonb_build_array(
        jsonb_build_object('code','6010','amt', 1500000),
        jsonb_build_object('code','1010','amt',-1500000)));

raise notice 'seed complete';
end
$seed$;
