-- Rizq Rasan platform: helpers, onboarding, listings.
-- Every action that changes state goes through a function that checks the
-- rules. The browser cannot write to these tables directly (see the RLS file).

alter table public.organisations add column frozen_until timestamptz;   -- strike ladder: 48-hour freeze

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.setting(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select value from public.settings where key = p_key
$$;

create or replace function public.setting_int(p_key text) returns integer
language sql stable security definer set search_path = public as $$
  select (value #>> '{}')::integer from public.settings where key = p_key
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

create or replace function public.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships where organisation_id = p_org and user_id = auth.uid())
$$;

create or replace function public.is_owner(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships where organisation_id = p_org and user_id = auth.uid() and role = 'owner')
$$;

create or replace function public.require_member(p_org uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please sign in first.' using errcode = '28000'; end if;
  if not public.is_member(p_org) then raise exception 'You are not a member of this organisation.' using errcode = '42501'; end if;
end $$;

create or replace function public.require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only Rizq Rasan admins can do this.' using errcode = '42501'; end if;
end $$;

create or replace function public.audit(p_action text, p_table text, p_row text, p_before jsonb, p_after jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.audit_log (actor, action, table_name, row_id, before, after)
  values (auth.uid(), p_action, p_table, p_row, p_before, p_after)
$$;

-- In-app notification for every member of an organisation (emailed by the send-notifications function).
create or replace function public.notify_org(p_org uuid, p_event text, p_title text, p_body text, p_link text default null) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, organisation_id, event, title, body, link)
  select m.user_id, p_org, p_event, p_title, p_body, p_link from public.memberships m where m.organisation_id = p_org
$$;

create or replace function public.notify_admins(p_event text, p_title text, p_body text, p_link text default null) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, event, title, body, link)
  select a.user_id, p_event, p_title, p_body, p_link from public.platform_admins a
$$;

create or replace function public.rs(p_amount integer) returns text
language sql immutable as $$
  select 'Rs ' || to_char(p_amount, 'FM999,999,999')
$$;

create or replace function public.pkt(p_time timestamptz) returns text
language sql immutable as $$
  select lower(to_char(p_time at time zone 'Asia/Karachi', 'FMHH12:MI am, Dy FMDD Mon'))
$$;

-- Reliability: average of outcomes over the last 90 days, as 0 to 100. New organisations start at 100.
create or replace function public.reliability_score(p_org uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(round(100 * avg(score))::integer, 100)
  from public.reliability_events
  where organisation_id = p_org and created_at > now() - interval '90 days'
$$;

create or replace function public.reliability_badge(p_org uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when public.reliability_score(p_org) >= 90 then 'Highly reliable'
    when public.reliability_score(p_org) >= 75 then 'Reliable'
    when public.reliability_score(p_org) >= 60 then 'Building a record'
    else 'Under review' end
$$;

create or replace function public.active_strikes(p_org uuid) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from public.strikes
  where organisation_id = p_org and forgiven_at is null and expires_at > now()
$$;

-- Strike ladder: 1 = warning, 2 = 48-hour freeze, 3 = 7-day suspension and admin review.
create or replace function public.add_strike(p_org uuid, p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.strikes (organisation_id, order_id, reason, expires_at)
  values (p_org, p_order, p_reason, now() + make_interval(days => public.setting_int('strike_expiry_days')));
  n := public.active_strikes(p_org);
  if n = 1 then
    perform public.notify_org(p_org, 'strike', 'You have a strike (warning)', p_reason || ' This is a warning. Strikes expire after 60 days.');
  elsif n = 2 then
    update public.organisations set frozen_until = now() + interval '48 hours' where id = p_org;
    perform public.notify_org(p_org, 'strike', 'Second strike: 48-hour freeze', p_reason || ' New claims and listings are paused for 48 hours.');
  else
    update public.organisations set status = 'suspended', status_reason = 'Three active strikes: 7-day suspension and review', frozen_until = now() + interval '7 days' where id = p_org;
    perform public.notify_org(p_org, 'strike', 'Account suspended for 7 days', p_reason || ' With three active strikes the account is suspended while we review it. You can appeal within 7 days.');
    perform public.notify_admins('review', 'Organisation suspended after 3 strikes', 'Review the organisation and decide whether to restore it.', '/admin/organisations/' || p_org);
  end if;
end $$;

create or replace function public.add_reliability(p_org uuid, p_order uuid, p_score numeric, p_note text) returns void
language sql security definer set search_path = public as $$
  insert into public.reliability_events (organisation_id, order_id, score, note) values (p_org, p_order, p_score, p_note)
$$;

-- Distance in km between two points (haversine).
create or replace function public.km_between(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 6371 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- ---------------------------------------------------------------------------
-- New users get a profile automatically
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''), new.raw_user_meta_data ->> 'phone')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Onboarding
-- ---------------------------------------------------------------------------
create or replace function public.create_organisation(p_type public.org_type, p_name text, p_business_kind text default null, p_phone text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in first.' using errcode = '28000'; end if;
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

-- Owners edit their organisation's details. Status, tier and approvals are admin-only.
create or replace function public.update_organisation(p_org uuid, p_fields jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  allowed text[] := array['name','legal_name','business_kind','registration_kind','registration_number','ntn','phone','email',
                          'address','sector','lat','lng','pickup_instructions','people_served_per_day',
                          'raast_id','bank_account_title','bank_iban'];
  k text; v_before jsonb; payout_change boolean := false;
begin
  perform public.require_member(p_org);
  if not public.is_owner(p_org) then raise exception 'Only the owner can change organisation details.' using errcode = '42501'; end if;
  for k in select jsonb_object_keys(p_fields) loop
    if not (k = any(allowed)) then raise exception 'The field % cannot be changed here.', k; end if;
  end loop;
  select to_jsonb(o) into v_before from public.organisations o where id = p_org;
  update public.organisations o set
    name = coalesce(p_fields ->> 'name', o.name),
    legal_name = case when p_fields ? 'legal_name' then p_fields ->> 'legal_name' else o.legal_name end,
    business_kind = case when p_fields ? 'business_kind' then p_fields ->> 'business_kind' else o.business_kind end,
    registration_kind = case when p_fields ? 'registration_kind' then p_fields ->> 'registration_kind' else o.registration_kind end,
    registration_number = case when p_fields ? 'registration_number' then p_fields ->> 'registration_number' else o.registration_number end,
    ntn = case when p_fields ? 'ntn' then p_fields ->> 'ntn' else o.ntn end,
    phone = case when p_fields ? 'phone' then p_fields ->> 'phone' else o.phone end,
    email = case when p_fields ? 'email' then p_fields ->> 'email' else o.email end,
    address = case when p_fields ? 'address' then p_fields ->> 'address' else o.address end,
    sector = case when p_fields ? 'sector' then p_fields ->> 'sector' else o.sector end,
    lat = case when p_fields ? 'lat' then nullif(p_fields ->> 'lat', '')::double precision else o.lat end,
    lng = case when p_fields ? 'lng' then nullif(p_fields ->> 'lng', '')::double precision else o.lng end,
    pickup_instructions = case when p_fields ? 'pickup_instructions' then p_fields ->> 'pickup_instructions' else o.pickup_instructions end,
    people_served_per_day = case when p_fields ? 'people_served_per_day' then nullif(p_fields ->> 'people_served_per_day', '')::integer else o.people_served_per_day end,
    raast_id = case when p_fields ? 'raast_id' then p_fields ->> 'raast_id' else o.raast_id end,
    bank_account_title = case when p_fields ? 'bank_account_title' then p_fields ->> 'bank_account_title' else o.bank_account_title end,
    bank_iban = case when p_fields ? 'bank_iban' then upper(replace(p_fields ->> 'bank_iban', ' ', '')) else o.bank_iban end
  where id = p_org;
  -- Changing where money goes pauses payouts for 48 hours (a common fraud pattern).
  if (p_fields ? 'bank_iban' and (v_before ->> 'bank_iban') is distinct from upper(replace(p_fields ->> 'bank_iban', ' ', '')) and v_before ->> 'bank_iban' is not null)
     or (p_fields ? 'raast_id' and (v_before ->> 'raast_id') is distinct from (p_fields ->> 'raast_id') and v_before ->> 'raast_id' is not null) then
    update public.organisations set payouts_paused_until = now() + make_interval(hours => public.setting_int('payout_account_pause_hours')) where id = p_org;
    perform public.notify_org(p_org, 'payout_account_changed', 'Your payment details changed',
      'Payouts are paused for 48 hours as a safety check. If you did not make this change, contact us now.');
  end if;
  perform public.audit('update_organisation', 'organisations', p_org::text, v_before, p_fields);
end $$;

create or replace function public.add_document(p_org uuid, p_kind text, p_path text, p_expires_on date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.require_member(p_org);
  if split_part(p_path, '/', 1) <> p_org::text then raise exception 'Upload documents into your organisation''s folder.'; end if;
  insert into public.documents (organisation_id, kind, file_path, expires_on, uploaded_by)
  values (p_org, p_kind, p_path, p_expires_on, auth.uid()) returning id into v_id;
  return v_id;
end $$;

create or replace function public.submit_for_review(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.organisations;
begin
  perform public.require_member(p_org);
  select * into o from public.organisations where id = p_org;
  if o.status not in ('onboarding', 'needs_changes') then raise exception 'This application has already been submitted.'; end if;
  if coalesce(o.phone, '') = '' or coalesce(o.address, '') = '' or coalesce(o.sector, '') = '' then
    raise exception 'Add a phone number, address and area before submitting.';
  end if;
  if o.type = 'vendor' and coalesce(o.ntn, '') = '' then raise exception 'Businesses need an NTN before submitting.'; end if;
  if not exists (select 1 from public.documents where organisation_id = p_org and status <> 'rejected') then
    raise exception 'Upload your documents before submitting.';
  end if;
  update public.organisations set status = 'pending_review', status_reason = null where id = p_org;
  perform public.notify_admins('verification', 'New application: ' || o.name, 'An application is waiting for review.', '/admin/verifications');
  perform public.notify_org(p_org, 'submitted', 'Application received', 'We check applications within 2 working days and will tell you if anything needs changing.');
end $$;

create or replace function public.accept_policies(p_org uuid, p_policies text[], p_version text default '0.1') returns void
language plpgsql security definer set search_path = public as $$
declare p text;
begin
  perform public.require_member(p_org);
  foreach p in array p_policies loop
    insert into public.policy_acceptances (user_id, organisation_id, policy, version) values (auth.uid(), p_org, p, p_version);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Listings
-- ---------------------------------------------------------------------------
create or replace function public.check_org_can_act(p_org uuid, p_type public.org_type) returns public.organisations
language plpgsql stable security definer set search_path = public as $$
declare o public.organisations;
begin
  perform public.require_member(p_org);
  select * into o from public.organisations where id = p_org;
  if o.type <> p_type then raise exception 'This is only for % accounts.', case p_type when 'vendor' then 'business' else 'NGO' end; end if;
  if o.status <> 'approved' then raise exception 'Your account is not approved yet.'; end if;
  if o.frozen_until is not null and o.frozen_until > now() then
    raise exception 'Your account is paused until % because of strikes.', public.pkt(o.frozen_until);
  end if;
  return o;
end $$;

-- Latest safe-until allowed for a category, storage and preparation time (null = no limit beyond the label date).
create or replace function public.max_safe_until(p_category text, p_storage text, p_prepared timestamptz) returns timestamptz
language plpgsql stable security definer set search_path = public as $$
declare c public.categories; h integer;
begin
  select * into c from public.categories where id = p_category;
  if c.uses_label_date then return null; end if;
  h := case p_storage when 'room' then c.max_hours_room when 'hot' then c.max_hours_hot else c.max_hours_chilled end;
  if h is null then raise exception '% cannot be listed when stored %.', c.name,
    case p_storage when 'room' then 'at room temperature' when 'hot' then 'hot' else 'chilled' end; end if;
  return p_prepared + make_interval(hours => h);
end $$;

create or replace function public.create_listing(
  p_vendor uuid, p_title text, p_category text, p_quantity numeric, p_unit text, p_weight_kg numeric,
  p_retail_value_rs integer, p_price_rs integer, p_storage text, p_prepared_at timestamptz, p_safe_until timestamptz,
  p_pickup_start timestamptz, p_pickup_end timestamptz, p_description text default null, p_feeds_about integer default null,
  p_dietary jsonb default '{}'::jsonb, p_instructions text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  o public.organisations; c public.categories; v_id uuid; cap timestamptz; live_count integer;
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
  if p_price_rs < public.setting_int('min_price_rs') then
    raise exception 'Listings start at %.', public.rs(public.setting_int('min_price_rs'));
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
    retail_value_rs, price_rs, storage, prepared_at, safe_until, pickup_start, pickup_end, dietary, instructions, created_by)
  values (p_vendor, trim(p_title), p_description, p_category, p_quantity, coalesce(nullif(p_unit, ''), 'pieces'), p_weight_kg, p_feeds_about,
    p_retail_value_rs, p_price_rs, p_storage, p_prepared_at, p_safe_until, p_pickup_start, p_pickup_end,
    coalesce(p_dietary, '{}'::jsonb), p_instructions, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.withdraw_listing(p_listing uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l public.listings;
begin
  select * into l from public.listings where id = p_listing for update;
  if l.id is null then raise exception 'Listing not found.'; end if;
  perform public.require_member(l.vendor_id);
  if l.status <> 'live' then raise exception 'Only live listings can be withdrawn. Claimed listings are locked.'; end if;
  update public.listings set status = 'withdrawn', status_reason = 'Withdrawn by vendor', updated_at = now() where id = p_listing;
end $$;

-- While a listing is live and unclaimed, the vendor can fix its wording.
create or replace function public.edit_listing(p_listing uuid, p_title text, p_description text, p_instructions text) returns void
language plpgsql security definer set search_path = public as $$
declare l public.listings;
begin
  select * into l from public.listings where id = p_listing for update;
  if l.id is null then raise exception 'Listing not found.'; end if;
  perform public.require_member(l.vendor_id);
  if l.status <> 'live' then raise exception 'Only live listings can be edited.'; end if;
  update public.listings set title = trim(p_title), description = p_description, instructions = p_instructions, updated_at = now()
  where id = p_listing;
end $$;

create or replace function public.add_listing_photo(p_listing uuid, p_path text) returns void
language plpgsql security definer set search_path = public as $$
declare l public.listings; n integer;
begin
  select * into l from public.listings where id = p_listing;
  if l.id is null then raise exception 'Listing not found.'; end if;
  perform public.require_member(l.vendor_id);
  if split_part(p_path, '/', 1) <> l.vendor_id::text then raise exception 'Upload photos into your business''s folder.'; end if;
  select count(*) into n from public.listing_photos where listing_id = p_listing;
  if n >= 3 then raise exception 'A listing can have up to 3 photos.'; end if;
  insert into public.listing_photos (listing_id, file_path, sort) values (p_listing, p_path, n);
end $$;
