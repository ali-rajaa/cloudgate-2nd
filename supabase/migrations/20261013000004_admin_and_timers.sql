-- Rizq Rasan platform: admin actions and the automatic timers.

-- ---------------------------------------------------------------------------
-- Admin: verification
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_org_status(p_org uuid, p_status public.org_status, p_reason text default null, p_tier public.ngo_tier default null)
returns void language plpgsql security definer set search_path = public as $$
declare o public.organisations;
begin
  perform public.require_admin();
  select * into o from public.organisations where id = p_org for update;
  if o.id is null then raise exception 'Organisation not found.'; end if;
  if p_status in ('needs_changes', 'rejected', 'suspended', 'removed') and coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason. The organisation will see it.';
  end if;
  update public.organisations set
    status = p_status, status_reason = nullif(trim(coalesce(p_reason, '')), ''),
    approved_at = case when p_status = 'approved' then coalesce(approved_at, now()) else approved_at end,
    tier = case when type = 'ngo' then coalesce(p_tier, tier, 'C') end,
    tier_c_until = case when type = 'ngo' and p_status = 'approved' and approved_at is null then now() + interval '30 days' else tier_c_until end,
    frozen_until = case when p_status = 'approved' then null else frozen_until end
  where id = p_org;
  if p_status in ('suspended', 'removed') then
    update public.listings set status = 'removed', status_reason = 'Account ' || p_status::text, updated_at = now()
    where vendor_id = p_org and status = 'live';
  end if;
  perform public.audit('set_org_status', 'organisations', p_org::text, jsonb_build_object('status', o.status, 'tier', o.tier),
    jsonb_build_object('status', p_status, 'tier', p_tier, 'reason', p_reason));
  perform public.notify_org(p_org, 'status',
    case p_status when 'approved' then 'Your account is approved'
                  when 'needs_changes' then 'Your application needs changes'
                  when 'rejected' then 'Your application was not approved'
                  when 'suspended' then 'Your account is suspended'
                  else 'Your account status changed' end,
    case p_status when 'approved' then case when o.type = 'vendor' then 'You can now list surplus food.' else 'You can now find and claim food near you.' end
                  else coalesce(p_reason, '') end);
end $$;

create or replace function public.admin_review_document(p_doc uuid, p_status public.doc_status, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  if p_status = 'rejected' and coalesce(trim(p_reason), '') = '' then raise exception 'Say what is wrong with the document.'; end if;
  update public.documents set status = p_status, reason = p_reason, reviewed_by = auth.uid(), reviewed_at = now() where id = p_doc;
  perform public.audit('review_document', 'documents', p_doc::text, null, jsonb_build_object('status', p_status, 'reason', p_reason));
end $$;

create or replace function public.admin_remove_listing(p_listing uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare l public.listings;
begin
  perform public.require_admin();
  select * into l from public.listings where id = p_listing for update;
  if l.status not in ('live', 'draft') then raise exception 'Only live listings can be removed. Cancel the order instead.'; end if;
  update public.listings set status = 'removed', status_reason = p_reason, updated_at = now() where id = p_listing;
  perform public.audit('remove_listing', 'listings', p_listing::text, null, jsonb_build_object('reason', p_reason));
  perform public.notify_org(l.vendor_id, 'listing_removed', 'Listing removed: ' || l.title, p_reason);
end $$;

create or replace function public.admin_cancel_order(p_order uuid, p_reason text, p_refund boolean) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders; l public.listings;
begin
  perform public.require_admin();
  select * into o from public.orders where id = p_order for update;
  if o.status in ('completed', 'completed_unconfirmed', 'expired_unpaid', 'released', 'cancelled_by_ngo', 'cancelled_by_vendor', 'refused_at_pickup', 'no_show') then
    raise exception 'This order has already ended.';
  end if;
  select * into l from public.listings where id = o.listing_id;
  update public.orders set status = 'cancelled_by_vendor', ended_at = now(), ended_reason = 'Cancelled by Rizq Rasan: ' || p_reason where id = p_order;
  update public.listings set status = 'removed', status_reason = p_reason, updated_at = now() where id = o.listing_id;
  if p_refund then perform public.issue_refund(p_order, o.price_rs, 'Cancelled by Rizq Rasan: ' || p_reason, 'platform'); end if;
  perform public.audit('cancel_order', 'orders', p_order::text, null, jsonb_build_object('reason', p_reason, 'refund', p_refund));
  perform public.notify_org(o.ngo_id, 'cancelled', 'Order cancelled: ' || l.title, p_reason);
  perform public.notify_org(o.vendor_id, 'cancelled', 'Order cancelled: ' || l.title, p_reason);
end $$;

create or replace function public.admin_decide_dispute(p_dispute uuid, p_decision text, p_refund_rs integer default 0, p_strike_org uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare d public.disputes; o public.orders; l public.listings;
begin
  perform public.require_admin();
  select * into d from public.disputes where id = p_dispute for update;
  if d.id is null then raise exception 'Report not found.'; end if;
  if d.status = 'decided' then raise exception 'This report has already been decided.'; end if;
  if coalesce(trim(p_decision), '') = '' then raise exception 'Write the decision. Both sides will see it.'; end if;
  select * into o from public.orders where id = d.order_id;
  select * into l from public.listings where id = o.listing_id;
  update public.disputes set status = 'decided', decision = trim(p_decision), refund_rs = nullif(p_refund_rs, 0),
    strike_org = p_strike_org, decided_by = auth.uid(), decided_at = now() where id = p_dispute;
  if coalesce(p_refund_rs, 0) > 0 then perform public.issue_refund(d.order_id, p_refund_rs, 'Problem report decision', 'vendor'); end if;
  if p_strike_org is not null then perform public.add_strike(p_strike_org, d.order_id, 'Upheld problem report on ' || l.title || '.'); end if;
  if o.status = 'picked_up' then perform public.complete_order(d.order_id, false); end if;
  perform public.audit('decide_dispute', 'disputes', p_dispute::text, null, jsonb_build_object('decision', p_decision, 'refund_rs', p_refund_rs, 'strike_org', p_strike_org));
  perform public.notify_org(o.ngo_id, 'dispute_decided', 'Decision on ' || l.title, p_decision);
  perform public.notify_org(o.vendor_id, 'dispute_decided', 'Decision on ' || l.title, p_decision);
end $$;

-- An admin can forgive one strike per organisation every 90 days.
create or replace function public.admin_forgive_strike(p_strike uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.strikes;
begin
  perform public.require_admin();
  select * into s from public.strikes where id = p_strike for update;
  if s.forgiven_at is not null then raise exception 'Already forgiven.'; end if;
  if exists (select 1 from public.strikes where organisation_id = s.organisation_id and forgiven_at > now() - interval '90 days') then
    raise exception 'A strike was forgiven for this organisation in the last 90 days.';
  end if;
  update public.strikes set forgiven_by = auth.uid(), forgiven_at = now() where id = p_strike;
  if public.active_strikes(s.organisation_id) < 2 then update public.organisations set frozen_until = null where id = s.organisation_id; end if;
  perform public.audit('forgive_strike', 'strikes', p_strike::text, null, null);
  perform public.notify_org(s.organisation_id, 'strike_forgiven', 'A strike was removed', 'Your appeal was accepted and the strike no longer counts.');
end $$;

create or replace function public.admin_update_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare old jsonb;
begin
  perform public.require_admin();
  select value into old from public.settings where key = p_key;
  if old is null then raise exception 'Unknown setting.'; end if;
  if jsonb_typeof(old) <> jsonb_typeof(p_value) then raise exception 'That value has the wrong type.'; end if;
  if p_key = 'payment_mode' and p_value #>> '{}' not in ('direct', 'payfast') then raise exception 'Payment mode must be direct or payfast.'; end if;
  update public.settings set value = p_value, updated_at = now(), updated_by = auth.uid() where key = p_key;
  perform public.audit('update_setting', 'settings', p_key, old, p_value);
end $$;

create or replace function public.admin_approve_refund(p_refund uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.refunds;
begin
  perform public.require_admin();
  select * into r from public.refunds where id = p_refund for update;
  if r.status <> 'pending_approval' then raise exception 'This refund doesn''t need approval.'; end if;
  if r.requested_by = auth.uid() then raise exception 'A second admin must approve refunds over Rs 10,000.'; end if;
  update public.refunds set status = 'approved', approved_by = auth.uid() where id = p_refund;
  perform public.audit('approve_refund', 'refunds', p_refund::text, null, null);
end $$;

create or replace function public.admin_mark_refund_sent(p_refund uuid, p_reference text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.refunds; t uuid := gen_random_uuid();
begin
  perform public.require_admin();
  select * into r from public.refunds where id = p_refund for update;
  if r.status <> 'approved' then raise exception 'Only approved refunds can be marked as sent.'; end if;
  update public.refunds set status = 'sent', gateway_reference = p_reference, sent_at = now() where id = p_refund;
  insert into public.ledger_entries (txn_id, account, order_id, debit_rs, credit_rs, memo) values
    (t, 'refunds_payable', r.order_id, r.amount_rs, 0, 'Refund paid out'),
    (t, 'gateway_clearing', r.order_id, 0, r.amount_rs, 'Refund paid out');
  perform public.audit('refund_sent', 'refunds', p_refund::text, null, jsonb_build_object('reference', p_reference));
end $$;

-- ---------------------------------------------------------------------------
-- Payouts: Monday and Thursday batches. One admin prepares, a second approves.
-- ---------------------------------------------------------------------------
create or replace function public.prepare_payout(p_run_date date default (now() at time zone 'Asia/Karachi')::date) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; total integer;
begin
  -- Runs from the scheduler (no user) or by an admin.
  if auth.uid() is not null then perform public.require_admin(); end if;
  -- Lines held for a recent payout account change become eligible when the pause ends.
  update public.payout_lines pl set status = 'eligible', hold_reason = null
  from public.organisations v
  where pl.vendor_id = v.id and pl.status = 'on_hold' and pl.hold_reason = 'Payout account recently changed'
    and (v.payouts_paused_until is null or v.payouts_paused_until <= now());
  select id into v_id from public.payouts where run_date = p_run_date;
  if v_id is null then
    insert into public.payouts (run_date, prepared_by) values (p_run_date, auth.uid()) returning id into v_id;
  end if;
  update public.payout_lines pl set payout_id = v_id, status = 'in_batch'
  from public.organisations v
  where pl.vendor_id = v.id and pl.status = 'eligible' and pl.net_rs > 0
    and (v.payouts_paused_until is null or v.payouts_paused_until <= now())
    and not exists (select 1 from public.disputes d where d.order_id = pl.order_id and d.status in ('open', 'awaiting_reply'));
  select coalesce(sum(net_rs), 0) into total from public.payout_lines where payout_id = v_id;
  update public.payouts set total_rs = total where id = v_id;
  if total > 0 then perform public.notify_admins('payout', 'Payout batch ready: ' || public.rs(total), 'A second admin needs to approve it.', '/admin/payouts'); end if;
  return v_id;
end $$;

create or replace function public.admin_approve_payout(p_payout uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p public.payouts;
begin
  perform public.require_admin();
  select * into p from public.payouts where id = p_payout for update;
  if p.status <> 'draft' then raise exception 'Only draft batches can be approved.'; end if;
  if p.prepared_by = auth.uid() then raise exception 'A different admin must approve the batch.'; end if;
  update public.payouts set status = 'approved', approved_by = auth.uid() where id = p_payout;
  perform public.audit('approve_payout', 'payouts', p_payout::text, null, jsonb_build_object('total_rs', p.total_rs));
end $$;

-- After the bank transfers are made: record each vendor's bank reference.
create or replace function public.admin_mark_payout_sent(p_payout uuid, p_references jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare p public.payouts; r record; t uuid;
begin
  perform public.require_admin();
  select * into p from public.payouts where id = p_payout for update;
  if p.status <> 'approved' then raise exception 'Approve the batch first.'; end if;
  for r in select vendor_id, sum(net_rs)::integer as net from public.payout_lines where payout_id = p_payout group by vendor_id loop
    t := gen_random_uuid();
    insert into public.ledger_entries (txn_id, account, organisation_id, debit_rs, credit_rs, memo) values
      (t, 'vendor_payable', r.vendor_id, r.net, 0, 'Payout sent'),
      (t, 'collections_bank', null, 0, r.net, 'Payout sent');
    update public.payout_lines set status = 'paid', paid_at = now(), bank_reference = p_references ->> r.vendor_id::text
    where payout_id = p_payout and vendor_id = r.vendor_id;
    perform public.notify_org(r.vendor_id, 'payout', 'Payout sent: ' || public.rs(r.net),
      'Your payout is on its way to your bank account. Bank reference: ' || coalesce(p_references ->> r.vendor_id::text, 'sent'), '/vendor/earnings');
  end loop;
  update public.payouts set status = 'sent', sent_at = now() where id = p_payout;
  perform public.audit('payout_sent', 'payouts', p_payout::text, null, p_references);
end $$;

create or replace function public.admin_reissue_code(p_order uuid) returns text
language plpgsql security definer set search_path = public as $$
declare o public.orders; v_code text;
begin
  perform public.require_admin();
  select * into o from public.orders where id = p_order for update;
  loop
    v_code := lpad((floor(random() * 10000))::integer::text, 4, '0');
    exit when v_code <> o.pickup_code and not exists (select 1 from public.orders where vendor_id = o.vendor_id and pickup_code = v_code and status in ('paid', 'awaiting_collection_answer'));
  end loop;
  update public.orders set pickup_code = v_code, code_attempts = 0, code_locked_until = null where id = p_order;
  perform public.audit('reissue_code', 'orders', p_order::text, null, null);
  perform public.notify_org(o.ngo_id, 'code_reissued', 'New pickup code', 'Your pickup code was changed by Rizq Rasan. Open the order to see it.', '/ngo/claims/' || p_order);
  return v_code;
end $$;

-- ---------------------------------------------------------------------------
-- Timers. Runs every minute. Every check also respects the stored deadlines,
-- so orders stay correct even if a run is late.
-- ---------------------------------------------------------------------------
create or replace function public.run_timers() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record; n_expired integer := 0; n_listings integer := 0; n_asked integer := 0; n_completed integer := 0; n_unconfirmed integer := 0;
  pause jsonb := public.setting('unpaid_expiry_pause'); cnt integer;
begin
  -- 1. Claims not paid in time.
  for r in
    select o.* from public.orders o
    where (o.status = 'payment_due' and o.payment_deadline <= now())
       or (o.status = 'payment_processing' and o.payment_mode = 'payfast' and coalesce(o.held_until, o.payment_deadline) <= now())
    for update skip locked
  loop
    update public.orders set status = 'expired_unpaid', ended_at = now(), ended_reason = 'Not paid before the deadline' where id = r.id;
    perform public.relist_or_expire(r.listing_id);
    perform public.add_reliability(r.ngo_id, r.id, 0.5, 'Claim expired unpaid');
    perform public.notify_org(r.ngo_id, 'expired', 'Claim expired', 'The payment deadline passed, so the food was released for other NGOs.');
    select count(*) into cnt from public.orders where ngo_id = r.ngo_id and status = 'expired_unpaid'
      and ended_at > now() - make_interval(days => (pause ->> 'days')::integer);
    if cnt >= (pause ->> 'count')::integer then
      update public.organisations set claims_paused_until = now() + make_interval(hours => (pause ->> 'pause_hours')::integer)
      where id = r.ngo_id and (claims_paused_until is null or claims_paused_until < now());
      perform public.notify_org(r.ngo_id, 'paused', 'Claiming paused for 24 hours',
        'Three claims expired unpaid in the last 7 days. This is not a strike, and claiming reopens automatically.');
    end if;
    n_expired := n_expired + 1;
  end loop;

  -- Direct mode: the vendor hasn't confirmed the NGO's payment in time. Keep the food held and alert an admin once.
  for r in select o.* from public.orders o
    where o.status = 'payment_processing' and o.payment_mode = 'direct' and o.held_until <= now()
      and not exists (select 1 from public.notifications nn where nn.event = 'direct_unconfirmed' and nn.link = '/admin/orders/' || o.id)
  loop
    perform public.notify_admins('direct_unconfirmed', 'Vendor hasn''t confirmed a payment', 'Phone both sides. The food stays held.', '/admin/orders/' || r.id);
  end loop;

  -- 2. Live listings whose pickup window has ended.
  update public.listings set status = 'expired', status_reason = 'Pickup window ended unclaimed', updated_at = now()
  where status = 'live' and pickup_end <= now();
  get diagnostics n_listings = row_count;

  -- 3. Paid but not collected: ask the vendor 30 minutes after the window ends.
  for r in select o.*, l.title, l.pickup_end from public.orders o join public.listings l on l.id = o.listing_id
    where o.status = 'paid' and l.pickup_end + make_interval(mins => public.setting_int('no_show_grace_minutes')) <= now()
  loop
    update public.orders set status = 'awaiting_collection_answer', collection_asked_at = now() where id = r.id;
    perform public.notify_org(r.vendor_id, 'collection_check', 'Did they collect? ' || r.title,
      'The pickup window has ended and no code was entered. Tell us whether the NGO collected the food.', '/vendor/pickups');
    n_asked := n_asked + 1;
  end loop;

  -- 4. Nobody answered for 48 hours: completed, unconfirmed. The vendor is paid; nobody's reliability changes.
  for r in select o.* from public.orders o join public.listings l on l.id = o.listing_id
    where o.status = 'awaiting_collection_answer' and l.pickup_end + make_interval(hours => public.setting_int('unconfirmed_complete_hours')) <= now()
  loop
    perform public.complete_order(r.id, true);
    n_unconfirmed := n_unconfirmed + 1;
  end loop;

  -- 5. Picked up 24 hours ago with no open problem: completed.
  for r in select o.* from public.orders o
    where o.status = 'picked_up' and o.picked_up_at + make_interval(hours => public.setting_int('problem_report_hours')) <= now()
      and not exists (select 1 from public.disputes d where d.order_id = o.id and d.status in ('open', 'awaiting_reply'))
  loop
    perform public.complete_order(r.id, false);
    n_completed := n_completed + 1;
  end loop;

  -- 6. Freezes and pauses that have run out.
  update public.organisations set frozen_until = null where frozen_until is not null and frozen_until <= now() and status <> 'suspended';
  update public.organisations set claims_paused_until = null where claims_paused_until is not null and claims_paused_until <= now();

  -- 7. New NGOs move from Tier C to Tier B after a month and 10 completed pickups.
  update public.organisations o set tier = 'B'
  where o.type = 'ngo' and o.status = 'approved' and o.tier = 'C' and o.tier_c_until <= now()
    and (select count(*) from public.orders x where x.ngo_id = o.id and x.status = 'completed') >= 10
    and public.active_strikes(o.id) = 0;

  return jsonb_build_object('expired_claims', n_expired, 'expired_listings', n_listings, 'asked_collection', n_asked,
    'completed', n_completed, 'completed_unconfirmed', n_unconfirmed);
end $$;

-- Schedule: timers every minute; payout batches at 9 am Pakistan time (04:00 UTC) on Mondays and Thursdays.
create extension if not exists pg_cron;
select cron.schedule('rizq-timers', '* * * * *', $$select public.run_timers()$$);
select cron.schedule('rizq-payouts', '0 4 * * 1,4', $$select public.prepare_payout()$$);

-- ---------------------------------------------------------------------------
-- Public impact totals, worked out from completed orders (never typed in).
-- ---------------------------------------------------------------------------
create or replace function public.impact_totals() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'kg_rescued', coalesce(round(sum(l.weight_kg)), 0),
    'meals', coalesce(floor(sum(l.weight_kg) / 0.42), 0),
    'co2e_kg', coalesce(round(sum(l.weight_kg) * 2.5), 0),
    'rupees_saved', coalesce(sum(l.retail_value_rs - o.price_rs), 0),
    'orders', count(*),
    'active_partners', (select count(*) from public.organisations where status = 'approved'))
  from public.orders o join public.listings l on l.id = o.listing_id
  where o.status in ('completed', 'completed_unconfirmed')
$$;
