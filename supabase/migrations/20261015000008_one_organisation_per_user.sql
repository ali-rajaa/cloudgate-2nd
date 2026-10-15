-- Rizq Rasan platform: one organisation per person.
--
-- If the set-up screen ran twice at the same moment (the account loading twice
-- after sign-in), both calls could pass create_organisation's "already belongs"
-- check and each create an organisation. Loading that person's account then
-- failed ("JSON object requested, multiple (or no) rows returned").
--
-- This migration:
-- 1. tidies up duplicates: for each person it keeps the organisation that is
--    furthest along, deletes extra ones that were only ever started (nothing
--    uploaded, listed, ordered or paid), and detaches any other extras;
-- 2. makes a second membership impossible (unique index);
-- 3. makes create_organisation take a per-person lock, so two calls at once
--    run one after the other and the second sees the first.

-- 1a. Delete extra organisations that are empty.
with ranked as (
  select m.user_id, m.organisation_id,
         row_number() over (
           partition by m.user_id
           order by (o.status <> 'onboarding') desc,
                    (select count(*) from public.documents d where d.organisation_id = o.id) desc,
                    o.created_at asc
         ) as rn
  from public.memberships m
  join public.organisations o on o.id = m.organisation_id
)
delete from public.organisations o
using ranked r
where r.rn > 1
  and o.id = r.organisation_id
  and o.status = 'onboarding'
  and (select count(*) from public.memberships m2 where m2.organisation_id = o.id) = 1
  and not exists (select 1 from public.documents d where d.organisation_id = o.id)
  and not exists (select 1 from public.listings l where l.vendor_id = o.id)
  and not exists (select 1 from public.orders x where x.vendor_id = o.id or x.ngo_id = o.id)
  and not exists (select 1 from public.ledger_entries x where x.organisation_id = o.id)
  and not exists (select 1 from public.payout_lines x where x.vendor_id = o.id)
  and not exists (select 1 from public.disputes x where x.raised_by_org = o.id or x.strike_org = o.id);

-- 1b. Any extras left have real data: keep the organisation, detach the person.
with ranked as (
  select m.user_id, m.organisation_id,
         row_number() over (
           partition by m.user_id
           order by (o.status <> 'onboarding') desc,
                    (select count(*) from public.documents d where d.organisation_id = o.id) desc,
                    o.created_at asc
         ) as rn
  from public.memberships m
  join public.organisations o on o.id = m.organisation_id
)
delete from public.memberships m
using ranked r
where r.rn > 1 and m.user_id = r.user_id and m.organisation_id = r.organisation_id;

-- 2. One membership per person from now on.
create unique index if not exists memberships_one_per_user on public.memberships (user_id);

-- 3. One create at a time per person.
create or replace function public.create_organisation(p_type public.org_type, p_name text, p_business_kind text default null, p_phone text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in first.' using errcode = '28000'; end if;
  -- Held until this transaction ends: a second call waits here, then sees the first one's membership.
  perform pg_advisory_xact_lock(hashtextextended('create_organisation:' || auth.uid()::text, 0));
  if exists (select 1 from public.memberships where user_id = auth.uid()) then
    raise exception 'Your account already belongs to an organisation.';
  end if;
  insert into public.organisations (type, name, business_kind, phone, created_by, tier)
  values (p_type, trim(p_name), p_business_kind, p_phone, auth.uid(), case when p_type = 'ngo' then 'C'::public.ngo_tier end)
  returning id into v_id;
  insert into public.memberships (organisation_id, user_id, role) values (v_id, auth.uid(), 'owner');
  perform public.audit('create_organisation', 'organisations', v_id::text, null, jsonb_build_object('type', p_type, 'name', p_name));
  return v_id;
end $$;
