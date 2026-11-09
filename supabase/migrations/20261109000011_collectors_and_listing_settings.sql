-- Rizq Rasan platform: collectors instead of NGOs, and listing settings.
--
-- Rizq Rasan no longer works with NGOs. The side that claims food is now a
-- "collector": an organization (university cafeteria, school canteen, office,
-- bulk buyer) or an individual. In the database the org_type value 'ngo' still
-- means "collector" (renaming an enum value would break every function that
-- uses it); the new collector_kind column says which kind.
--
-- Every listing now carries settings instead of separate flows:
-- - audience: who can claim it (organizations, public or both)
-- - sold_as: one lot or single items (single items open with public listings)
-- - price: up to half of retail as before, or Rs 0 to give it away
-- Public listings are switched off at launch (setting public_listings_open):
-- listings go to organizations only until an admin turns it on.

-- 1. Collector kind.
alter table public.organisations add column if not exists collector_kind text
  check (collector_kind in ('organization', 'individual'));
update public.organisations set collector_kind = 'organization' where type = 'ngo' and collector_kind is null;

-- 2. Listing settings.
alter table public.listings add column if not exists audience text not null default 'organizations'
  check (audience in ('organizations', 'public', 'both'));
alter table public.listings add column if not exists sold_as text not null default 'lot'
  check (sold_as in ('lot', 'items'));

-- Rs 0 listings are allowed (the price used to have to be above 0).
alter table public.listings drop constraint if exists listings_price_rs_check;
alter table public.listings add constraint listings_price_rs_check check (price_rs >= 0);

insert into public.settings (key, value, description) values
  ('public_listings_open', 'false', 'Whether vendors can offer listings to the public and individuals can claim them. Off at launch.')
on conflict (key) do nothing;

-- 3. Creating an account's organisation, with the collector kind.
drop function if exists public.create_organisation(public.org_type, text, text, text);
create function public.create_organisation(p_type public.org_type, p_name text, p_business_kind text default null,
  p_phone text default null, p_kind text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_kind text;
begin
  if auth.uid() is null then raise exception 'Please sign in first.' using errcode = '28000'; end if;
  -- Held until this transaction ends: a second call waits here, then sees the first one's membership.
  perform pg_advisory_xact_lock(hashtextextended('create_organisation:' || auth.uid()::text, 0));
  if exists (select 1 from public.memberships where user_id = auth.uid()) then
    raise exception 'Your account already belongs to an organisation.';
  end if;
  if p_type = 'ngo' then
    v_kind := coalesce(p_kind, 'organization');
    if v_kind not in ('organization', 'individual') then raise exception 'Choose an organization or an individual account.'; end if;
  end if;
  insert into public.organisations (type, name, business_kind, phone, created_by, tier, collector_kind)
  values (p_type, trim(p_name), p_business_kind, p_phone, auth.uid(), case when p_type = 'ngo' then 'C'::public.ngo_tier end, v_kind)
  returning id into v_id;
  insert into public.memberships (organisation_id, user_id, role) values (v_id, auth.uid(), 'owner');
  perform public.audit('create_organisation', 'organisations', v_id::text, null, jsonb_build_object('type', p_type, 'kind', v_kind, 'name', p_name));
  return v_id;
end $$;
revoke execute on function public.create_organisation(public.org_type, text, text, text, text) from public, anon;
grant execute on function public.create_organisation(public.org_type, text, text, text, text) to authenticated;

-- 4. What an application needs. Individuals need only their CNIC.
create or replace function public.submit_for_review(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.organisations;
  has_doc boolean;
begin
  perform public.require_member(p_org);
  select * into o from public.organisations where id = p_org;
  if o.status not in ('onboarding', 'needs_changes') then raise exception 'This application has already been submitted.'; end if;
  if coalesce(o.phone, '') = '' or coalesce(o.address, '') = '' or coalesce(o.sector, '') = '' then
    raise exception 'Add a phone number, address and area before submitting.';
  end if;
  if not exists (select 1 from public.documents where organisation_id = p_org and status <> 'rejected' and kind = 'signatory_cnic') then
    raise exception 'Upload the CNIC before submitting.';
  end if;
  if o.type = 'vendor' then
    select exists (select 1 from public.documents where organisation_id = p_org and status <> 'rejected'
      and kind in ('registration', 'ifa_licence', 'ntn', 'address_proof', 'bank_letter', 'dts')) into has_doc;
    if not has_doc then raise exception 'Upload one proof of your business before submitting.'; end if;
    if o.raast_id is null and o.bank_iban is null then raise exception 'Add a Raast ID or an IBAN so collectors can pay you.'; end if;
  elsif coalesce(o.collector_kind, 'organization') = 'organization' then
    if not exists (select 1 from public.documents where organisation_id = p_org and status <> 'rejected' and kind = 'registration') then
      raise exception 'Upload a proof of your organization before submitting.';
    end if;
  end if;
  update public.organisations set status = 'pending_review', status_reason = null where id = p_org;
  perform public.notify_admins('verification', 'New application: ' || o.name, 'An application is waiting for review.', '/admin/verifications');
  perform public.notify_org(p_org, 'submitted', 'Application received', 'We check applications within 2 working days and will tell you if anything needs changing.');
end $$;

-- 5. Listings: Rs 0 allowed, plus who can claim and how it's sold.
drop function if exists public.create_listing(uuid, text, text, numeric, text, numeric, integer, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, integer, jsonb, text);
create function public.create_listing(
  p_vendor uuid, p_title text, p_category text, p_quantity numeric, p_unit text, p_weight_kg numeric,
  p_retail_value_rs integer, p_price_rs integer, p_storage text, p_prepared_at timestamptz, p_safe_until timestamptz,
  p_pickup_start timestamptz, p_pickup_end timestamptz, p_description text default null, p_feeds_about integer default null,
  p_dietary jsonb default '{}'::jsonb, p_instructions text default null,
  p_audience text default 'organizations', p_sold_as text default 'lot'
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  o public.organisations; c public.categories; v_id uuid; cap timestamptz; live_count integer; public_open boolean;
begin
  o := public.check_org_can_act(p_vendor, 'vendor');
  select * into c from public.categories where id = p_category;
  if c.id is null then raise exception 'Choose a food category.'; end if;
  if c.opens = 'phase2' then raise exception '% can''t be listed yet.', c.name; end if;
  if c.opens = 'cooked' and not (public.setting('cooked_food_open') #>> '{}')::boolean then
    raise exception 'Cooked food can''t be listed yet. It opens once the pilot has shown the rules work.';
  end if;
  if c.cooked and p_storage = 'room' and extract(month from now() at time zone 'Asia/Karachi')::integer in
     (select jsonb_array_elements_text(public.setting('hot_months'))::integer) then
    raise exception 'From May to September cooked food can''t be listed at room temperature. Keep it hot or chilled.';
  end if;
  public_open := coalesce((public.setting('public_listings_open') #>> '{}')::boolean, false);
  if p_audience not in ('organizations', 'public', 'both') then raise exception 'Choose who can claim this listing.'; end if;
  if p_audience <> 'organizations' and not public_open then
    raise exception 'Listings are for organizations only until public listings open.';
  end if;
  if p_sold_as not in ('lot', 'items') then raise exception 'Choose how this listing is sold.'; end if;
  if p_sold_as = 'items' and not public_open then
    raise exception 'Single items open together with public listings. List it as one lot for now.';
  end if;
  -- Rs 0 gives the food away; otherwise the usual floor and the cap at a share of retail.
  if p_price_rs < 0 then raise exception 'The price can''t be negative.'; end if;
  if p_price_rs > 0 and p_price_rs < public.setting_int('min_price_rs') then
    raise exception 'Listings start at %, or Rs 0 to give it away.', public.rs(public.setting_int('min_price_rs'));
  end if;
  if p_price_rs > floor(p_retail_value_rs * (public.setting('max_price_share_of_retail') #>> '{}')::numeric) then
    raise exception 'The price can be at most half of the retail value (% for this listing).',
      public.rs(floor(p_retail_value_rs * (public.setting('max_price_share_of_retail') #>> '{}')::numeric)::integer);
  end if;
  if p_prepared_at > now() + interval '5 minutes' then raise exception 'The preparation time can''t be in the future.'; end if;
  cap := public.max_safe_until(p_category, p_storage, p_prepared_at);
  if cap is not null and p_safe_until > cap then
    raise exception 'For this food the safe-until time can be at most %.', public.pkt(cap);
  end if;
  if p_pickup_end < now() + make_interval(mins => public.setting_int('min_listing_lead_minutes')) then
    raise exception 'Pickup must end at least % minutes from now.', public.setting_int('min_listing_lead_minutes');
  end if;
  if p_pickup_end - p_pickup_start < make_interval(mins => public.setting_int('min_pickup_window_minutes')) then
    raise exception 'The pickup window must be at least % minutes long.', public.setting_int('min_pickup_window_minutes');
  end if;
  if p_pickup_end > p_safe_until - make_interval(mins => public.setting_int('safe_until_margin_minutes')) then
    raise exception 'Pickup must end at least % minutes before the food''s safe-until time.', public.setting_int('safe_until_margin_minutes');
  end if;
  if public.reliability_score(p_vendor) < public.setting_int('reliability_floor') then
    select count(*) into live_count from public.listings where vendor_id = p_vendor and status = 'live';
    if live_count >= 3 then raise exception 'While your reliability is under review you can have at most 3 live listings.'; end if;
  end if;
  insert into public.listings (vendor_id, title, description, category_id, quantity, unit, weight_kg, feeds_about,
    retail_value_rs, price_rs, storage, prepared_at, safe_until, pickup_start, pickup_end, dietary, instructions, created_by,
    audience, sold_as)
  values (p_vendor, trim(p_title), p_description, p_category, p_quantity, coalesce(nullif(p_unit, ''), 'pieces'), p_weight_kg, p_feeds_about,
    p_retail_value_rs, p_price_rs, p_storage, p_prepared_at, p_safe_until, p_pickup_start, p_pickup_end,
    coalesce(p_dietary, '{}'::jsonb), p_instructions, auth.uid(), p_audience, p_sold_as)
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.create_listing(uuid, text, text, numeric, text, numeric, integer, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, integer, jsonb, text, text, text) from public, anon;
grant execute on function public.create_listing(uuid, text, text, numeric, text, numeric, integer, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, integer, jsonb, text, text, text) to authenticated;

-- Can this collector see and claim this listing?
create or replace function public.listing_open_to(p_collector public.organisations, p_audience text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when coalesce(p_collector.collector_kind, 'organization') = 'organization' then p_audience in ('organizations', 'both')
    else p_audience in ('public', 'both') and coalesce((public.setting('public_listings_open') #>> '{}')::boolean, false)
  end
$$;
revoke execute on function public.listing_open_to(public.organisations, text) from public, anon, authenticated;

-- 6. Finding food: only listings this collector may claim.
create or replace function public.search_listings(p_ngo uuid, p_radius_km numeric default null, p_category text default null, p_max_price integer default null)
returns table (
  id uuid, title text, description text, category_id text, category_name text, quantity numeric, unit text, weight_kg numeric,
  feeds_about integer, retail_value_rs integer, price_rs integer, storage text, safe_until timestamptz,
  pickup_start timestamptz, pickup_end timestamptz, dietary jsonb, vendor_name text, vendor_sector text,
  vendor_badge text, distance_km numeric, photo_path text, can_claim boolean
) language plpgsql stable security definer set search_path = public as $$
declare n public.organisations; radius numeric;
begin
  n := public.check_org_can_act(p_ngo, 'ngo');
  radius := coalesce(p_radius_km, public.setting_int('browse_radius_km'));
  return query
  select l.id, l.title, l.description, l.category_id, c.name, l.quantity, l.unit, l.weight_kg, l.feeds_about,
    l.retail_value_rs, l.price_rs, l.storage, l.safe_until, l.pickup_start, l.pickup_end, l.dietary,
    v.name, v.sector, public.reliability_badge(v.id),
    case when n.lat is null or v.lat is null then null
         else round(public.km_between(n.lat, n.lng, v.lat, v.lng)::numeric, 1) end,
    (select p.file_path from public.listing_photos p where p.listing_id = l.id order by p.sort limit 1),
    (l.price_rs = 0 or
     least(now() + make_interval(mins => public.setting_int('payment_window_minutes')),
           l.pickup_end - make_interval(mins => public.setting_int('payment_cutoff_before_end_minutes')))
      - now() >= make_interval(mins => public.setting_int('min_minutes_to_pay')))
  from public.listings l
  join public.organisations v on v.id = l.vendor_id and v.status = 'approved'
  join public.categories c on c.id = l.category_id
  where l.status = 'live' and l.pickup_end > now()
    and public.listing_open_to(n, l.audience)
    and (p_category is null or l.category_id = p_category)
    and (p_max_price is null or l.price_rs <= p_max_price)
    and (n.lat is null or v.lat is null or public.km_between(n.lat, n.lng, v.lat, v.lng) <= radius)
  order by l.pickup_end asc;
end $$;

-- 7. Claiming: the audience rule, and Rs 0 listings are ready to collect at once.
create or replace function public.claim_listing(p_ngo uuid, p_listing uuid, p_collector uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  n public.organisations; l public.listings; v public.organisations; v_order uuid; v_code text; tries integer := 0;
  deadline timestamptz; limits jsonb; tier text; unpaid integer; today integer; mode public.payment_mode;
  commission integer; pct numeric; free boolean;
begin
  n := public.check_org_can_act(p_ngo, 'ngo');
  if n.claims_paused_until is not null and n.claims_paused_until > now() then
    raise exception 'Claiming is paused until % because 3 claims expired unpaid this week.', public.pkt(n.claims_paused_until);
  end if;
  if p_collector is not null and not exists (select 1 from public.collectors where id = p_collector and organisation_id = p_ngo and active) then
    raise exception 'Choose one of your own collectors.';
  end if;

  -- Tier limits (Tier C limits also apply when reliability is under the floor).
  tier := case when public.reliability_score(p_ngo) < public.setting_int('reliability_floor') then 'C' else coalesce(n.tier::text, 'C') end;
  limits := public.setting('tier_limits') -> tier;
  select count(*) into unpaid from public.orders where ngo_id = p_ngo and status in ('payment_due', 'payment_processing');
  if unpaid >= (limits ->> 'unpaid')::integer then
    raise exception 'Pay for your current claim first. You can hold % unpaid claim(s) at a time.', limits ->> 'unpaid';
  end if;
  if limits ->> 'daily' is not null then
    select count(*) into today from public.orders
    where ngo_id = p_ngo and (created_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date;
    if today >= (limits ->> 'daily')::integer then
      raise exception 'You can make % claims a day for now. Your limit resets at midnight.', limits ->> 'daily';
    end if;
  end if;

  select * into l from public.listings where id = p_listing for update;
  if l.id is null then raise exception 'Listing not found.'; end if;
  if l.status <> 'live' or l.pickup_end <= now() then
    raise exception 'This listing was just claimed by someone else or has ended.' using errcode = 'P0001';
  end if;
  if not public.listing_open_to(n, l.audience) then
    raise exception 'This listing isn''t open to your account.';
  end if;
  select * into v from public.organisations where id = l.vendor_id;
  if v.status <> 'approved' then raise exception 'This business can''t take claims right now.'; end if;

  free := l.price_rs = 0;
  mode := (public.setting('payment_mode') #>> '{}')::public.payment_mode;
  if free then
    deadline := now();
    commission := 0;
  else
    deadline := least(now() + make_interval(mins => public.setting_int('payment_window_minutes')),
                      l.pickup_end - make_interval(mins => public.setting_int('payment_cutoff_before_end_minutes')));
    if deadline - now() < make_interval(mins => public.setting_int('min_minutes_to_pay')) then
      raise exception 'There isn''t enough time left to pay before pickup ends.';
    end if;
    if mode = 'direct' and v.raast_id is null and v.bank_iban is null then
      raise exception 'This business hasn''t added its payment details yet.';
    end if;
    pct := (public.setting('commission_percent') #>> '{}')::numeric;
    commission := case when mode = 'direct' and not (public.setting('charge_commission_in_direct_mode') #>> '{}')::boolean then 0
                       else floor(l.price_rs * pct / 100) end;
  end if;

  -- 4-digit pickup code, unique among this vendor's active orders today.
  loop
    v_code := lpad((floor(random() * 10000))::integer::text, 4, '0');
    exit when not exists (select 1 from public.orders where vendor_id = l.vendor_id and pickup_code = v_code
      and (created_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date);
    tries := tries + 1;
    if tries > 50 then raise exception 'Could not create a pickup code. Please try again.'; end if;
  end loop;

  update public.listings set status = 'claimed', updated_at = now() where id = p_listing;
  insert into public.orders (listing_id, vendor_id, ngo_id, claimed_by, collector_id, payment_mode, price_rs, commission_rs,
    vendor_share_rs, payment_deadline, pickup_code, status, paid_at)
  values (p_listing, l.vendor_id, p_ngo, auth.uid(), p_collector, mode, l.price_rs, commission, l.price_rs - commission, deadline, v_code,
    case when free then 'paid'::public.order_status else 'payment_due'::public.order_status end, case when free then now() end)
  returning id into v_order;

  if free then
    perform public.notify_org(l.vendor_id, 'claimed', 'Claimed: ' || l.title,
      n.name || ' claimed it (Rs 0). Hand it over when they give you the right pickup code.', '/vendor/pickups');
  else
    perform public.notify_org(l.vendor_id, 'claimed', 'Claimed: ' || l.title,
      n.name || ' claimed it for ' || public.rs(l.price_rs) || '. They pay by ' || public.pkt(deadline) || '. Don''t hand over the food until it shows as paid.',
      '/vendor/pickups');
  end if;
  return v_order;
end $$;
