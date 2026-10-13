-- Direct (pilot) payments: the NGO's bank or Raast reference is free text and two
-- NGOs could type the same one, so it can't be the payment's unique reference.
-- Each confirmed payment gets its own reference; the NGO's stays on the order.
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
    values (p_order, 'direct', 'direct-' || p_order, 'raast', o.price_rs, 'succeeded', now());
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

-- A reused gateway reference is flagged to admins instead of failing the notification.
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
  elsif exists (select 1 from public.payments where gateway = 'payfast' and gateway_reference = p_reference) then
    -- A gateway reference must never be reused; flag it instead of failing.
    perform public.notify_admins('payment_reference_reused', 'Gateway reference reused', 'Reference ' || p_reference || ' arrived again for order ' || left(p_order::text, 8) || '. Check it with PayFast.', '/admin/payments');
    v_result := 'reference_reused';
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


-- More than one payout batch can be made on the same day (for example a manual run after the scheduled one was sent).
alter table public.payouts drop constraint if exists payouts_run_date_key;
create index if not exists payouts_run_date_idx on public.payouts (run_date);

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
  -- Reuse today's batch only while it is still a draft; once approved or sent, start a new one.
  select id into v_id from public.payouts where run_date = p_run_date and status = 'draft' order by created_at desc limit 1;
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

