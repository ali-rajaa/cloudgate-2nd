-- Rizq Rasan platform: browsing, claims, payments, pickup, cancellations, problems.

-- ---------------------------------------------------------------------------
-- Ledger helpers. Every rupee is a balanced pair of entries; nothing is edited.
-- ---------------------------------------------------------------------------
create or replace function public.post_payment_ledger(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders; t uuid := gen_random_uuid();
begin
  select * into o from public.orders where id = p_order;
  insert into public.ledger_entries (txn_id, account, organisation_id, order_id, debit_rs, credit_rs, memo) values
    (t, 'gateway_clearing', null, o.id, o.price_rs, 0, 'NGO payment received'),
    (t, 'vendor_payable', o.vendor_id, o.id, 0, o.vendor_share_rs, 'Vendor share');
  if o.commission_rs > 0 then
    insert into public.ledger_entries (txn_id, account, organisation_id, order_id, debit_rs, credit_rs, memo)
    values (t, 'commission_revenue', null, o.id, 0, o.commission_rs, 'Commission (services tax included)');
  end if;
end $$;

-- A refund reverses the sale in proportion: the vendor's share and our commission both come back.
create or replace function public.issue_refund(p_order uuid, p_amount integer, p_reason text, p_borne_by text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  o public.orders; pay public.payments; v_id uuid; t uuid := gen_random_uuid();
  from_vendor integer; from_commission integer; v_status public.refund_status;
begin
  select * into o from public.orders where id = p_order;
  select * into pay from public.payments where order_id = p_order and status in ('succeeded', 'partly_refunded') limit 1;
  if pay.id is null then return null; end if;     -- nothing was paid through us (direct mode): nothing to refund
  if p_amount <= 0 then return null; end if;
  p_amount := least(p_amount, o.price_rs);
  v_status := case when p_amount > public.setting_int('second_admin_refund_rs') then 'pending_approval' else 'approved' end;
  insert into public.refunds (order_id, payment_id, amount_rs, reason, borne_by, status, requested_by)
  values (p_order, pay.id, p_amount, p_reason, p_borne_by, v_status, auth.uid()) returning id into v_id;
  from_commission := floor(o.commission_rs::numeric * p_amount / o.price_rs);
  from_vendor := p_amount - from_commission;
  insert into public.ledger_entries (txn_id, account, organisation_id, order_id, debit_rs, credit_rs, memo) values
    (t, 'vendor_payable', o.vendor_id, o.id, from_vendor, 0, 'Refund: vendor share returned'),
    (t, 'refunds_payable', null, o.id, 0, p_amount, 'Refund owed to NGO');
  if from_commission > 0 then
    insert into public.ledger_entries (txn_id, account, organisation_id, order_id, debit_rs, credit_rs, memo)
    values (t, 'commission_revenue', null, o.id, from_commission, 0, 'Refund: commission returned');
  end if;
  update public.payments set status = (case when p_amount >= o.price_rs then 'refunded' else 'partly_refunded' end)::public.payment_status where id = pay.id;
  update public.payout_lines set gross_rs = greatest(gross_rs - p_amount, 0),
    commission_rs = greatest(commission_rs - from_commission, 0),
    net_rs = greatest(net_rs - from_vendor, 0)
  where order_id = p_order and status in ('pending', 'eligible', 'on_hold');
  if v_status = 'pending_approval' then
    perform public.notify_admins('refund', 'Refund needs a second admin', public.rs(p_amount) || ' for order ' || left(p_order::text, 8), '/admin/payments');
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- NGOs: find food
-- ---------------------------------------------------------------------------
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
    (least(now() + make_interval(mins => public.setting_int('payment_window_minutes')),
           l.pickup_end - make_interval(mins => public.setting_int('payment_cutoff_before_end_minutes')))
      - now() >= make_interval(mins => public.setting_int('min_minutes_to_pay')))
  from public.listings l
  join public.organisations v on v.id = l.vendor_id and v.status = 'approved'
  join public.categories c on c.id = l.category_id
  where l.status = 'live' and l.pickup_end > now()
    and (p_category is null or l.category_id = p_category)
    and (p_max_price is null or l.price_rs <= p_max_price)
    and (n.lat is null or v.lat is null or public.km_between(n.lat, n.lng, v.lat, v.lng) <= radius)
  order by l.pickup_end asc;
end $$;

-- ---------------------------------------------------------------------------
-- Claiming. One atomic step: the listing goes from live to claimed only if it is
-- still live, and the unique index allows one active order per listing.
-- ---------------------------------------------------------------------------
create or replace function public.claim_listing(p_ngo uuid, p_listing uuid, p_collector uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  n public.organisations; l public.listings; v public.organisations; v_order uuid; v_code text; tries integer := 0;
  deadline timestamptz; limits jsonb; tier text; unpaid integer; today integer; mode public.payment_mode;
  commission integer; pct numeric;
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
    raise exception 'Pay for your current claim first. Tier % organisations can hold % unpaid claim(s) at a time.', tier, limits ->> 'unpaid';
  end if;
  if limits ->> 'daily' is not null then
    select count(*) into today from public.orders
    where ngo_id = p_ngo and (created_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date;
    if today >= (limits ->> 'daily')::integer then
      raise exception 'Tier % organisations can make % claims a day. Your limit resets at midnight.', tier, limits ->> 'daily';
    end if;
  end if;

  select * into l from public.listings where id = p_listing for update;
  if l.id is null then raise exception 'Listing not found.'; end if;
  if l.status <> 'live' or l.pickup_end <= now() then
    raise exception 'This listing was just claimed by another NGO or has ended.' using errcode = 'P0001';
  end if;
  select * into v from public.organisations where id = l.vendor_id;
  if v.status <> 'approved' then raise exception 'This business can''t take claims right now.'; end if;

  deadline := least(now() + make_interval(mins => public.setting_int('payment_window_minutes')),
                    l.pickup_end - make_interval(mins => public.setting_int('payment_cutoff_before_end_minutes')));
  if deadline - now() < make_interval(mins => public.setting_int('min_minutes_to_pay')) then
    raise exception 'There isn''t enough time left to pay before pickup ends.';
  end if;

  mode := (public.setting('payment_mode') #>> '{}')::public.payment_mode;
  if mode = 'direct' and coalesce(v.raast_id, v.bank_iban, '') = '' then
    raise exception 'This business hasn''t added its payment details yet.';
  end if;
  pct := (public.setting('commission_percent') #>> '{}')::numeric;
  commission := case when mode = 'direct' and not (public.setting('charge_commission_in_direct_mode') #>> '{}')::boolean then 0
                     else floor(l.price_rs * pct / 100) end;

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
    vendor_share_rs, payment_deadline, pickup_code)
  values (p_listing, l.vendor_id, p_ngo, auth.uid(), p_collector, mode, l.price_rs, commission, l.price_rs - commission, deadline, v_code)
  returning id into v_order;

  perform public.notify_org(l.vendor_id, 'claimed', 'Claimed: ' || l.title,
    n.name || ' claimed it for ' || public.rs(l.price_rs) || '. They pay by ' || public.pkt(deadline) || '. Don''t hand over the food until it shows as paid.',
    '/vendor/pickups');
  return v_order;
end $$;

-- NGO lets go of a claim before paying. The listing goes back to live if there is still time.
create or replace function public.release_claim(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders; l public.listings;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'Order not found.'; end if;
  perform public.require_member(o.ngo_id);
  if o.status <> 'payment_due' then raise exception 'Only unpaid claims can be released. After paying, cancel instead.'; end if;
  update public.orders set status = 'released', ended_at = now(), ended_reason = 'Released by NGO before paying' where id = p_order;
  perform public.relist_or_expire(o.listing_id);
  select * into l from public.listings where id = o.listing_id;
  perform public.notify_org(o.vendor_id, 'released', 'Claim released: ' || l.title,
    case when l.status = 'live' then 'The NGO let it go before paying. Your listing is live again.' else 'The NGO let it go before paying. The listing has ended.' end);
end $$;

create or replace function public.relist_or_expire(p_listing uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l public.listings;
begin
  select * into l from public.listings where id = p_listing for update;
  if l.pickup_end - make_interval(mins => public.setting_int('payment_cutoff_before_end_minutes') + public.setting_int('min_minutes_to_pay')) > now() then
    update public.listings set status = 'live', updated_at = now() where id = p_listing;
  else
    update public.listings set status = 'expired', status_reason = 'Its claim ended without a pickup', updated_at = now() where id = p_listing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Payment: direct mode (pilot). The NGO pays the vendor's Raast ID or bank
-- account itself, then the vendor confirms the money arrived.
-- ---------------------------------------------------------------------------
create or replace function public.direct_payment_details(p_order uuid)
returns table (amount_rs integer, raast_id text, bank_account_title text, bank_iban text, deadline timestamptz, reference text)
language plpgsql stable security definer set search_path = public as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null then raise exception 'Order not found.'; end if;
  perform public.require_member(o.ngo_id);
  if o.payment_mode <> 'direct' then raise exception 'This order is paid through the payment gateway.'; end if;
  return query select o.price_rs, v.raast_id, v.bank_account_title, v.bank_iban, o.payment_deadline, 'RR-' || upper(left(o.id::text, 8))
  from public.organisations v where v.id = o.vendor_id;
end $$;

create or replace function public.ngo_mark_paid(p_order uuid, p_reference text) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders; l public.listings;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'Order not found.'; end if;
  perform public.require_member(o.ngo_id);
  if o.payment_mode <> 'direct' then raise exception 'This order is paid through the payment gateway.'; end if;
  if o.status <> 'payment_due' then raise exception 'This order can''t be marked as paid now.'; end if;
  if o.payment_deadline < now() then raise exception 'The payment deadline has passed.'; end if;
  if length(trim(coalesce(p_reference, ''))) < 4 then raise exception 'Enter the transaction reference from your banking app.'; end if;
  update public.orders set status = 'payment_processing', ngo_payment_reference = trim(p_reference), ngo_marked_paid_at = now(),
    held_until = now() + make_interval(mins => public.setting_int('direct_confirm_minutes'))
  where id = p_order;
  select * into l from public.listings where id = o.listing_id;
  perform public.notify_org(o.vendor_id, 'ngo_paid', 'Check your account: ' || public.rs(o.price_rs),
    'The NGO says it has paid for ' || l.title || ' (reference ' || trim(p_reference) || '). Confirm when the money arrives.', '/vendor/pickups');
end $$;

create or replace function public.vendor_confirm_payment(p_order uuid, p_received boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders; l public.listings;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'Order not found.'; end if;
  perform public.require_member(o.vendor_id);
  if o.payment_mode <> 'direct' or o.status not in ('payment_processing', 'payment_due') then
    raise exception 'This order isn''t waiting for your confirmation.';
  end if;
  select * into l from public.listings where id = o.listing_id;
  if p_received then
    update public.orders set status = 'paid', paid_at = now() where id = p_order;
    insert into public.payments (order_id, gateway, gateway_reference, method, amount_rs, status, succeeded_at)
    values (p_order, 'direct', coalesce(o.ngo_payment_reference, 'direct-' || p_order), 'raast', o.price_rs, 'succeeded', now());
    perform public.notify_org(o.ngo_id, 'paid', 'Paid: ' || l.title,
      'The business confirmed your payment. Your pickup code is ready. Collect between ' || public.pkt(l.pickup_start) || ' and ' || public.pkt(l.pickup_end) || '.',
      '/ngo/claims/' || p_order);
  else
    update public.orders set status = 'payment_due' where id = p_order;
    perform public.notify_org(o.ngo_id, 'payment_not_received', 'Payment not received yet',
      'The business hasn''t received your payment for ' || l.title || '. Check the details and pay before the deadline.', '/ngo/claims/' || p_order);
    perform public.notify_admins('payment_check', 'Direct payment disputed', 'The vendor says the money has not arrived for order ' || left(p_order::text, 8), '/admin/orders');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Payment: gateway (PayFast). Only the server-side payment notification can mark
-- an order paid, and the amount always comes from our database.
-- ---------------------------------------------------------------------------
create or replace function public.gateway_checkout_details(p_order uuid)
returns table (order_id uuid, amount_rs integer, title text, deadline timestamptz, status public.order_status, payer_email text)
language plpgsql stable security definer set search_path = public as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null then raise exception 'Order not found.'; end if;
  perform public.require_member(o.ngo_id);
  return query select o.id, o.price_rs, l.title, o.payment_deadline, o.status, (select email from auth.users where id = auth.uid())
  from public.listings l where l.id = o.listing_id;
end $$;

-- Called only by the payment notification Edge Function (service role).
create or replace function public.record_gateway_payment(
  p_order uuid, p_reference text, p_amount integer, p_method text, p_event_id text, p_body jsonb, p_signature_valid boolean, p_success boolean
) returns text language plpgsql security definer set search_path = public as $$
declare o public.orders; l public.listings; v_result text;
begin
  insert into public.payment_events (gateway, event_id, signature_valid, body)
  values ('payfast', p_event_id, p_signature_valid, p_body)
  on conflict (gateway, event_id) do nothing;
  if not found then return 'duplicate'; end if;
  if not p_signature_valid then
    update public.payment_events set processed_at = now(), result = 'bad_signature' where gateway = 'payfast' and event_id = p_event_id;
    return 'bad_signature';
  end if;

  select * into o from public.orders where id = p_order for update;
  if o.id is null then v_result := 'unknown_order';
  elsif not p_success then
    insert into public.payments (order_id, gateway, gateway_reference, method, amount_rs, status)
    values (p_order, 'payfast', p_reference, p_method, greatest(p_amount, 1), 'failed') on conflict do nothing;
    if o.status = 'payment_processing' then update public.orders set status = 'payment_due' where id = p_order; end if;
    v_result := 'failed';
  elsif p_amount <> o.price_rs then
    perform public.notify_admins('payment_mismatch', 'Payment amount mismatch', 'Order ' || left(p_order::text, 8) || ': paid ' || p_amount || ', expected ' || o.price_rs, '/admin/payments');
    v_result := 'amount_mismatch';
  elsif exists (select 1 from public.payments where order_id = p_order and status in ('succeeded', 'refunded', 'partly_refunded')) then
    v_result := 'already_paid';
  else
    insert into public.payments (order_id, gateway, gateway_reference, method, amount_rs, status, succeeded_at)
    values (p_order, 'payfast', p_reference, p_method, p_amount, 'succeeded', now());
    perform public.post_payment_ledger(p_order);
    select * into l from public.listings where id = o.listing_id;
    if o.status in ('payment_due', 'payment_processing') then
      update public.orders set status = 'paid', paid_at = now() where id = p_order;
      perform public.notify_org(o.ngo_id, 'paid', 'Paid: ' || l.title,
        'Payment confirmed. Your pickup code is ready. Collect between ' || public.pkt(l.pickup_start) || ' and ' || public.pkt(l.pickup_end) || '.', '/ngo/claims/' || p_order);
      perform public.notify_org(o.vendor_id, 'paid', 'Paid: ' || l.title,
        'The NGO has paid ' || public.rs(o.price_rs) || '. Get the food ready and check their pickup code at the counter.', '/vendor/pickups');
      v_result := 'paid';
    else
      -- Money arrived after the claim ended: refund it in full.
      perform public.issue_refund(p_order, p_amount, 'Payment arrived after the claim ended', 'platform');
      v_result := 'late_refunded';
    end if;
  end if;
  update public.payment_events set processed_at = now(), result = v_result where gateway = 'payfast' and event_id = p_event_id;
  return v_result;
end $$;

-- The NGO started checkout: hold the food during processing.
create or replace function public.gateway_checkout_started(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if o.payment_deadline - now() < interval '5 minutes' then raise exception 'There isn''t enough time left to start a payment.'; end if;
  if o.status = 'payment_due' then
    update public.orders set status = 'payment_processing', held_until = o.payment_deadline + make_interval(mins => public.setting_int('processing_grace_minutes')) where id = p_order;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- What each side can see about an order. NGOs see the vendor's address and phone
-- only after paying; vendors never see the pickup code or the NGO's address.
-- ---------------------------------------------------------------------------
create or replace function public.order_details(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o public.orders; l public.listings; v public.organisations; n public.organisations; c public.collectors;
  is_ngo boolean; is_vendor boolean; paid boolean;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null then raise exception 'Order not found.'; end if;
  is_ngo := public.is_member(o.ngo_id); is_vendor := public.is_member(o.vendor_id);
  if not (is_ngo or is_vendor or public.is_admin()) then raise exception 'Order not found.'; end if;
  select * into l from public.listings where id = o.listing_id;
  select * into v from public.organisations where id = o.vendor_id;
  select * into n from public.organisations where id = o.ngo_id;
  select * into c from public.collectors where id = o.collector_id;
  paid := o.status in ('paid', 'awaiting_collection_answer', 'picked_up', 'completed', 'completed_unconfirmed');
  return jsonb_build_object(
    'id', o.id, 'status', o.status, 'payment_mode', o.payment_mode, 'price_rs', o.price_rs,
    'commission_rs', o.commission_rs, 'vendor_share_rs', o.vendor_share_rs, 'payment_deadline', o.payment_deadline,
    'held_until', o.held_until, 'paid_at', o.paid_at, 'picked_up_at', o.picked_up_at, 'completed_at', o.completed_at,
    'quantity_handed_over', o.quantity_handed_over, 'ended_reason', o.ended_reason, 'created_at', o.created_at,
    'reference', 'RR-' || upper(left(o.id::text, 8)), 'ngo_payment_reference', o.ngo_payment_reference,
    'listing', jsonb_build_object('id', l.id, 'title', l.title, 'quantity', l.quantity, 'unit', l.unit, 'weight_kg', l.weight_kg,
       'pickup_start', l.pickup_start, 'pickup_end', l.pickup_end, 'safe_until', l.safe_until, 'dietary', l.dietary,
       'storage', l.storage, 'instructions', l.instructions, 'category_id', l.category_id),
    'vendor', jsonb_build_object('name', v.name, 'sector', v.sector, 'badge', public.reliability_badge(v.id),
       'address', case when is_vendor or public.is_admin() or (is_ngo and paid) then v.address end,
       'phone', case when is_vendor or public.is_admin() or (is_ngo and paid) then v.phone end,
       'pickup_instructions', case when is_vendor or public.is_admin() or (is_ngo and paid) then v.pickup_instructions end,
       'lat', case when is_ngo and paid or public.is_admin() then v.lat end,
       'lng', case when is_ngo and paid or public.is_admin() then v.lng end),
    'ngo', jsonb_build_object('name', n.name, 'badge', public.reliability_badge(n.id),
       'phone', case when is_ngo or public.is_admin() or (is_vendor and paid) then n.phone end),
    'collector', case when c.id is null then null else jsonb_build_object('name', c.name,
       'phone', case when is_ngo or public.is_admin() or (is_vendor and paid) then c.phone end) end,
    'pickup_code', case when (is_ngo or public.is_admin()) and paid then o.pickup_code end,
    'viewer', case when is_ngo then 'ngo' when is_vendor then 'vendor' else 'admin' end
  );
end $$;

-- ---------------------------------------------------------------------------
-- Handover: the vendor types the NGO's code. 5 wrong tries in 10 minutes locks entry.
-- ---------------------------------------------------------------------------
create or replace function public.verify_pickup_code(p_vendor uuid, p_code text, p_quantity numeric default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders; l public.listings; lim jsonb; recent integer;
begin
  perform public.check_org_can_act(p_vendor, 'vendor');
  lim := public.setting('pickup_code_attempts');
  if exists (select 1 from public.orders where vendor_id = p_vendor and code_locked_until > now()) then
    raise exception 'Too many wrong codes. Code entry is locked for a few minutes.';
  end if;
  select * into o from public.orders
  where vendor_id = p_vendor and pickup_code = p_code and status in ('paid', 'awaiting_collection_answer')
  order by paid_at desc limit 1 for update;
  if o.id is null then
    -- Count the miss against every active order of this vendor.
    update public.orders set
      code_attempts = case when code_window_started_at > now() - make_interval(mins => (lim ->> 'window_minutes')::integer) then code_attempts + 1 else 1 end,
      code_window_started_at = case when code_window_started_at > now() - make_interval(mins => (lim ->> 'window_minutes')::integer) then code_window_started_at else now() end
    where vendor_id = p_vendor and status in ('paid', 'awaiting_collection_answer');
    select coalesce(max(code_attempts), 0) into recent from public.orders where vendor_id = p_vendor and status in ('paid', 'awaiting_collection_answer');
    if recent >= (lim ->> 'max')::integer then
      update public.orders set code_locked_until = now() + make_interval(mins => (lim ->> 'lock_minutes')::integer)
      where vendor_id = p_vendor and status in ('paid', 'awaiting_collection_answer');
      perform public.notify_admins('code_lock', 'Pickup code entry locked', 'A vendor entered 5 wrong codes in 10 minutes.', '/admin/orders');
    end if;
    return jsonb_build_object('ok', false, 'message', 'That code doesn''t match a paid order. Check it with the collector.');
  end if;
  select * into l from public.listings where id = o.listing_id;
  update public.orders set status = 'picked_up', picked_up_at = now(), quantity_handed_over = coalesce(p_quantity, l.quantity),
    code_attempts = 0, code_window_started_at = null where id = o.id;
  perform public.notify_org(o.ngo_id, 'picked_up', 'Collected: ' || l.title,
    'The food was handed over. If anything is wrong, report it within 24 hours; otherwise the order completes automatically.', '/ngo/claims/' || o.id);
  return jsonb_build_object('ok', true, 'order_id', o.id, 'title', l.title, 'price_rs', o.price_rs);
end $$;

-- After the window ends without a code: "Did they collect?"
create or replace function public.vendor_answer_collection(p_order uuid, p_collected boolean) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders; l public.listings;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'Order not found.'; end if;
  perform public.require_member(o.vendor_id);
  if o.status not in ('awaiting_collection_answer', 'paid') then raise exception 'This order isn''t waiting for an answer.'; end if;
  select * into l from public.listings where id = o.listing_id;
  if p_collected then
    update public.orders set status = 'picked_up', picked_up_at = coalesce(picked_up_at, now()) where id = p_order;
  else
    -- No-show: no refund, the vendor is paid, the NGO gets a strike.
    update public.orders set status = 'no_show', ended_at = now(), ended_reason = 'NGO did not collect' where id = p_order;
    update public.listings set status = 'completed', updated_at = now() where id = o.listing_id;
    perform public.add_strike(o.ngo_id, p_order, 'No-show for ' || l.title || '.');
    perform public.add_reliability(o.ngo_id, p_order, 0, 'No-show');
    perform public.make_payout_line(p_order);
    perform public.notify_org(o.ngo_id, 'no_show', 'Marked as not collected: ' || l.title,
      'The business says nobody collected the food. Payments are not refunded for no-shows. If this is wrong, report a problem within 24 hours.', '/ngo/claims/' || p_order);
  end if;
end $$;

-- NGO confirms the food arrived as described.
create or replace function public.ngo_confirm_receipt(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'Order not found.'; end if;
  perform public.require_member(o.ngo_id);
  if o.status <> 'picked_up' then raise exception 'You can confirm once the food has been handed over.'; end if;
  if exists (select 1 from public.disputes where order_id = p_order and status in ('open', 'awaiting_reply')) then
    raise exception 'This order has an open problem report.';
  end if;
  perform public.complete_order(p_order, false);
end $$;

create or replace function public.complete_order(p_order uuid, p_unconfirmed boolean) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  update public.orders set status = case when p_unconfirmed then 'completed_unconfirmed'::public.order_status else 'completed'::public.order_status end,
    completed_at = now() where id = p_order;
  update public.listings set status = 'completed', updated_at = now() where id = o.listing_id;
  if not p_unconfirmed then
    perform public.add_reliability(o.ngo_id, p_order, 1, 'Collected');
    perform public.add_reliability(o.vendor_id, p_order, 1, 'Handed over');
  end if;
  perform public.make_payout_line(p_order);
end $$;

-- Vendor's share becomes payable once the order is done (gateway mode only; in direct mode the NGO paid the vendor).
create or replace function public.make_payout_line(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders; v public.organisations; refunded integer;
begin
  select * into o from public.orders where id = p_order;
  if o.payment_mode <> 'payfast' then return; end if;
  if not exists (select 1 from public.payments where order_id = p_order and status in ('succeeded', 'partly_refunded')) then return; end if;
  select * into v from public.organisations where id = o.vendor_id;
  select coalesce(sum(amount_rs), 0) into refunded from public.refunds where order_id = p_order and status <> 'rejected';
  insert into public.payout_lines (order_id, vendor_id, gross_rs, commission_rs, net_rs, status, hold_reason)
  values (p_order, o.vendor_id, o.price_rs - refunded,
    o.commission_rs - floor(o.commission_rs::numeric * refunded / o.price_rs)::integer,
    o.vendor_share_rs - (refunded - floor(o.commission_rs::numeric * refunded / o.price_rs)::integer),
    (case when v.payouts_paused_until > now() or coalesce(v.bank_iban, '') = '' then 'on_hold' else 'eligible' end)::public.payout_line_status,
    case when coalesce(v.bank_iban, '') = '' then 'No payout account' when v.payouts_paused_until > now() then 'Payout account recently changed' end)
  on conflict (order_id) do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- Cancellations
-- ---------------------------------------------------------------------------
create or replace function public.ngo_cancel_order(p_order uuid) returns text
language plpgsql security definer set search_path = public as $$
declare o public.orders; l public.listings; early boolean;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'Order not found.'; end if;
  perform public.require_member(o.ngo_id);
  if o.status = 'payment_due' then perform public.release_claim(p_order); return 'released'; end if;
  if o.status not in ('paid', 'payment_processing') then raise exception 'This order can''t be cancelled now.'; end if;
  select * into l from public.listings where id = o.listing_id;
  early := l.pickup_start - now() >= make_interval(mins => public.setting_int('cancel_refund_minutes'));
  if early then
    update public.orders set status = 'cancelled_by_ngo', ended_at = now(), ended_reason = 'Cancelled by NGO in good time' where id = p_order;
    perform public.issue_refund(p_order, o.price_rs, 'NGO cancelled 60+ minutes before pickup', 'platform');
    perform public.relist_or_expire(o.listing_id);
    perform public.notify_org(o.vendor_id, 'cancelled', 'Cancelled: ' || l.title, 'The NGO cancelled in good time. ' ||
      case when o.payment_mode = 'direct' then 'Please return their payment.' else 'They have been refunded.' end);
    return 'cancelled_refunded';
  else
    -- Too close to pickup: treated as a no-show (no refund, vendor paid, strike).
    update public.orders set status = 'no_show', ended_at = now(), ended_reason = 'Cancelled by NGO within 60 minutes of pickup' where id = p_order;
    update public.listings set status = 'completed', updated_at = now() where id = o.listing_id;
    perform public.add_strike(o.ngo_id, p_order, 'Late cancellation for ' || l.title || ' counts as a no-show.');
    perform public.add_reliability(o.ngo_id, p_order, 0, 'Late cancellation');
    perform public.make_payout_line(p_order);
    perform public.notify_org(o.vendor_id, 'cancelled', 'Cancelled late: ' || l.title, 'The NGO cancelled within 60 minutes of pickup. You are still paid.');
    return 'cancelled_no_refund';
  end if;
end $$;

create or replace function public.vendor_cancel_order(p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders; l public.listings;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'Order not found.'; end if;
  perform public.require_member(o.vendor_id);
  if o.status not in ('payment_due', 'payment_processing', 'paid', 'awaiting_collection_answer') then raise exception 'This order can''t be cancelled now.'; end if;
  select * into l from public.listings where id = o.listing_id;
  update public.orders set status = 'cancelled_by_vendor', ended_at = now(), ended_reason = coalesce(nullif(trim(p_reason), ''), 'Cancelled by vendor') where id = p_order;
  update public.listings set status = 'withdrawn', status_reason = 'Order cancelled by vendor', updated_at = now() where id = o.listing_id;
  if o.status <> 'payment_due' then
    perform public.issue_refund(p_order, o.price_rs, 'Vendor cancelled after payment', 'vendor');
    perform public.add_strike(o.vendor_id, p_order, 'Cancelled ' || l.title || ' after the NGO paid.');
    perform public.add_reliability(o.vendor_id, p_order, 0, 'Cancelled after payment');
  end if;
  perform public.notify_org(o.ngo_id, 'cancelled', 'Cancelled by the business: ' || l.title,
    case when o.status = 'payment_due' then 'The business cancelled before you paid. Nothing was charged.'
         when o.payment_mode = 'direct' then 'The business cancelled after you paid. They must return your payment; contact us if they don''t within 1 working day.'
         else 'The business cancelled. You will get a full refund.' end, '/ngo/claims/' || p_order);
end $$;

-- ---------------------------------------------------------------------------
-- Problems (disputes). Either side can report within 24 hours of pickup.
-- ---------------------------------------------------------------------------
create or replace function public.report_problem(p_order uuid, p_kind text, p_details text) returns uuid
language plpgsql security definer set search_path = public as $$
declare o public.orders; v_id uuid; mine uuid; other uuid; l public.listings;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null then raise exception 'Order not found.'; end if;
  if public.is_member(o.ngo_id) then mine := o.ngo_id; other := o.vendor_id;
  elsif public.is_member(o.vendor_id) then mine := o.vendor_id; other := o.ngo_id;
  else raise exception 'Order not found.'; end if;
  if o.picked_up_at is not null and o.picked_up_at < now() - make_interval(hours => public.setting_int('problem_report_hours')) then
    raise exception 'Problems must be reported within 24 hours of pickup. Contact us if something serious happened.';
  end if;
  if length(trim(coalesce(p_details, ''))) < 10 then raise exception 'Describe what went wrong in a sentence or two.'; end if;
  insert into public.disputes (order_id, raised_by_org, raised_by, kind, details, status)
  values (p_order, mine, auth.uid(), p_kind, trim(p_details), 'awaiting_reply') returning id into v_id;
  select * into l from public.listings where id = o.listing_id;
  if p_kind = 'refused_unsafe' or p_kind = 'food_safety' then
    perform public.notify_admins('food_safety', 'Food safety report: ' || l.title, 'Decide within 24 hours.', '/admin/disputes');
  else
    perform public.notify_admins('dispute', 'Problem reported: ' || l.title, 'Acknowledge within 4 working hours, decide within 48 hours.', '/admin/disputes');
  end if;
  perform public.notify_org(other, 'dispute', 'A problem was reported: ' || l.title, 'Please reply within 24 hours with your side.', '/disputes/' || v_id);
  return v_id;
end $$;

create or replace function public.reply_to_problem(p_dispute uuid, p_reply text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.disputes; o public.orders;
begin
  select * into d from public.disputes where id = p_dispute for update;
  if d.id is null then raise exception 'Report not found.'; end if;
  select * into o from public.orders where id = d.order_id;
  if not ((public.is_member(o.ngo_id) or public.is_member(o.vendor_id)) and not public.is_member(d.raised_by_org)) then
    raise exception 'Only the other side can reply.';
  end if;
  update public.disputes set reply = trim(p_reply), status = 'open' where id = p_dispute;
end $$;

-- The collector refuses unsafe food at the counter: full refund, vendor strike.
create or replace function public.refuse_at_pickup(p_order uuid, p_details text) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders; l public.listings;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'Order not found.'; end if;
  perform public.require_member(o.ngo_id);
  if o.status not in ('paid', 'awaiting_collection_answer') then raise exception 'Food can be refused only at pickup.'; end if;
  select * into l from public.listings where id = o.listing_id;
  update public.orders set status = 'refused_at_pickup', ended_at = now(), ended_reason = 'Refused at pickup: ' || left(trim(p_details), 200) where id = p_order;
  update public.listings set status = 'removed', status_reason = 'Refused at pickup as unsafe', updated_at = now() where id = o.listing_id;
  insert into public.disputes (order_id, raised_by_org, raised_by, kind, details, status)
  values (p_order, o.ngo_id, auth.uid(), 'food_safety', 'Refused at pickup: ' || trim(p_details), 'open');
  perform public.issue_refund(p_order, o.price_rs, 'Refused at pickup as unsafe', 'vendor');
  perform public.notify_admins('food_safety', 'Food refused at pickup: ' || l.title, 'Decide within 24 hours whether the refusal is upheld.', '/admin/disputes');
  perform public.notify_org(o.vendor_id, 'refused', 'Food refused at pickup: ' || l.title, 'The collector refused the food as unsafe. Our team will review it within 24 hours.');
end $$;
