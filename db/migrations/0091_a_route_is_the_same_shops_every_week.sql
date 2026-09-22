-- A route is the same shops, every week.
--
-- A trip is one day. A route — a beat, in the trade — is the standing
-- arrangement behind it: these shops, in this order, visited on these days,
-- normally by this salesman on this truck. Distributors here run beats
-- because a shopkeeper needs to know which day somebody calls, and because
-- a route that exists only in a salesman's head leaves with him.
--
-- This is the part general ERPs tend not to have, so it is worth being
-- clear about what it is and is not. A route is not a schedule that fires
-- by itself: somebody presses generate, on the morning of the run, and gets
-- a trip they can then change. Nothing is posted, nothing is automatic, and
-- a trip once generated has no further tie to the route beyond remembering
-- where it came from. A plan that quietly created records overnight would
-- be a system nobody trusts by Thursday.

-- ------------------------------------------------------------- the route ---

create table if not exists route (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references company(id) on delete cascade,
  code         text not null,
  name         text not null,
  -- The branch it runs out of, and who normally runs it. Defaults copied on
  -- to each generated trip rather than read through it: the beat says who
  -- usually goes, the trip records who actually went, and a driver who
  -- swapped last Tuesday must not rewrite last Tuesday's answer.
  location_id  uuid references location(id),
  salesman_id  uuid references salesman(id),
  driver_id    uuid references driver(id),
  vehicle_id   uuid references vehicle(id),
  -- ISO weekdays, 1 = Monday. An array rather than seven booleans because
  -- the question asked of it is always "does today belong to this route",
  -- and because a beat that runs Monday and Thursday is one row.
  weekdays     smallint[] not null default '{}',
  note         text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (company_id, code),
  constraint route_weekdays_valid
    check (weekdays <@ array[1,2,3,4,5,6,7]::smallint[])
);

-- The standing call list. One row per shop, in visiting order.
create table if not exists route_stop (
  id          uuid primary key default gen_random_uuid(),
  route_id    uuid not null references route(id) on delete cascade,
  seq         integer not null,
  partner_id  uuid not null references business_partner(id),
  note        text,
  created_at  timestamptz not null default now(),
  -- A shop appears once on a beat. Twice is a data entry slip, not a plan.
  unique (route_id, partner_id)
);

-- Deferred for the same reason the trip's is: reordering swaps numbers
-- within one transaction and briefly duplicates one.
alter table route_stop drop constraint if exists route_stop_route_id_seq_key;
alter table route_stop
  add constraint route_stop_route_id_seq_key
  unique (route_id, seq) deferrable initially deferred;

-- --------------------------------------------- a stop is a place you go ---

-- Until now a stop *was* a delivery. A beat calls on a shop whether or not
-- there are goods for it — on a pre-sale round the whole point of the call
-- is to come back with an order — so a stop becomes a place you go, which
-- may or may not be carrying a document.
alter table delivery_trip_stop alter column document_id drop not null;
alter table delivery_trip_stop
  add column if not exists partner_id uuid references business_partner(id);

-- Backfill, so every existing stop answers "whose shop is this" the same
-- way a generated one does, rather than only through its document.
update delivery_trip_stop s
   set partner_id = d.partner_id
  from document d
 where d.id = s.document_id
   and s.partner_id is null;

-- A stop with neither is not a stop.
alter table delivery_trip_stop drop constraint if exists delivery_trip_stop_has_a_target;
alter table delivery_trip_stop
  add constraint delivery_trip_stop_has_a_target
  check (document_id is not null or partner_id is not null);

-- Where the trip came from. Null for one built by hand, which stays the
-- ordinary case.
alter table delivery_trip
  add column if not exists route_id uuid references route(id);

-- One run of a beat per day. A route generated twice by two people on the
-- same morning is the mistake this prevents; a cancelled run does not count,
-- so a trip called off can be regenerated.
create unique index if not exists ux_delivery_trip_route_day
  on delivery_trip (route_id, trip_date)
  where route_id is not null and status <> 'CANCELLED';

-- ---------------------------------------------------------------- views ---

create or replace view v_route as
select r.id, r.company_id, r.code, r.name, r.weekdays, r.note, r.is_active,
       r.location_id, r.salesman_id, r.driver_id, r.vehicle_id, r.created_at,
       l.name as location_name,
       s.name as salesman_name,
       d.name as driver_name,
       v.plate_no,
       (select count(*) from route_stop rs where rs.route_id = r.id) as stops,
       (select max(t.trip_date) from delivery_trip t
         where t.route_id = r.id and t.status <> 'CANCELLED') as last_run
  from route r
  left join location l on l.id = r.location_id
  left join salesman s on s.id = r.salesman_id
  left join driver   d on d.id = r.driver_id
  left join vehicle  v on v.id = r.vehicle_id;

-- The trip view gains the route it came from. Restated in full because a
-- view cannot have a column added to the middle of it.
create or replace view v_delivery_trip as
select t.id, t.company_id, t.trip_no, t.trip_date, t.status,
       t.location_id, t.vehicle_id, t.driver_id, t.salesman_id,
       t.departed_at, t.closed_at, t.note, t.created_at,
       l.code  as location_code, l.name as location_name,
       v.code  as vehicle_code,  v.plate_no,
       d.name  as driver_name,
       s.name  as salesman_name,
       count(st.id)                                            as stops,
       count(st.id) filter (where st.status = 'DELIVERED')      as delivered,
       count(st.id) filter (where st.status = 'FAILED')         as failed,
       count(st.id) filter (where st.status = 'PENDING')        as pending,
       coalesce(sum(doc.gross_total), 0)                        as goods_value,
       t.route_id,
       r.code  as route_code,
       r.name  as route_name
  from delivery_trip t
  left join location            l  on l.id  = t.location_id
  left join vehicle             v  on v.id  = t.vehicle_id
  left join driver              d  on d.id  = t.driver_id
  left join salesman            s  on s.id  = t.salesman_id
  left join route               r  on r.id  = t.route_id
  left join delivery_trip_stop  st on st.trip_id = t.id
  left join document           doc on doc.id = st.document_id
 group by t.id, l.code, l.name, v.code, v.plate_no, d.name, s.name,
          r.code, r.name;
