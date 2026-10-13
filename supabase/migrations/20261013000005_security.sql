-- Rizq Rasan platform: row level security, column privileges and file storage.
-- The rule: people read only what their organisation is allowed to see, and
-- every change goes through the functions in the earlier migrations.

-- ---------------------------------------------------------------------------
-- Lock everything down first
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

revoke execute on all functions in schema public from public, anon;
grant usage on schema public to anon, authenticated;

-- Functions signed-in people may call (each checks membership or admin rights itself).
grant execute on function
  public.is_admin(), public.is_member(uuid), public.reliability_score(uuid), public.reliability_badge(uuid),
  public.create_organisation(public.org_type, text, text, text), public.update_organisation(uuid, jsonb),
  public.add_document(uuid, text, text, date), public.submit_for_review(uuid), public.accept_policies(uuid, text[], text),
  public.max_safe_until(text, text, timestamptz),
  public.create_listing(uuid, text, text, numeric, text, numeric, integer, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, integer, jsonb, text),
  public.withdraw_listing(uuid), public.edit_listing(uuid, text, text, text), public.add_listing_photo(uuid, text),
  public.search_listings(uuid, numeric, text, integer), public.claim_listing(uuid, uuid, uuid), public.release_claim(uuid),
  public.direct_payment_details(uuid), public.ngo_mark_paid(uuid, text), public.vendor_confirm_payment(uuid, boolean),
  public.gateway_checkout_details(uuid), public.order_details(uuid),
  public.verify_pickup_code(uuid, text, numeric), public.vendor_answer_collection(uuid, boolean), public.ngo_confirm_receipt(uuid),
  public.ngo_cancel_order(uuid), public.vendor_cancel_order(uuid, text),
  public.report_problem(uuid, text, text), public.reply_to_problem(uuid, text), public.refuse_at_pickup(uuid, text),
  public.admin_set_org_status(uuid, public.org_status, text, public.ngo_tier), public.admin_review_document(uuid, public.doc_status, text),
  public.admin_remove_listing(uuid, text), public.admin_cancel_order(uuid, text, boolean),
  public.admin_decide_dispute(uuid, text, integer, uuid), public.admin_forgive_strike(uuid), public.admin_update_setting(text, jsonb),
  public.admin_approve_refund(uuid), public.admin_mark_refund_sent(uuid, text),
  public.prepare_payout(date), public.admin_approve_payout(uuid), public.admin_mark_payout_sent(uuid, jsonb), public.admin_reissue_code(uuid),
  public.rs(integer), public.pkt(timestamptz), public.active_strikes(uuid)
to authenticated;

-- Anyone, signed in or not, can read the public impact totals.
grant execute on function public.impact_totals() to anon, authenticated;

-- Gateway functions run only from Edge Functions with the service role.
revoke execute on function public.record_gateway_payment(uuid, text, integer, text, text, jsonb, boolean, boolean) from authenticated;
revoke execute on function public.gateway_checkout_started(uuid) from authenticated;
revoke execute on function public.run_timers() from authenticated;
grant execute on function public.record_gateway_payment(uuid, text, integer, text, text, jsonb, boolean, boolean) to service_role;
grant execute on function public.gateway_checkout_started(uuid) to service_role;
grant execute on function public.run_timers() to service_role;

-- ---------------------------------------------------------------------------
-- Read access (select) per table. Writes go through functions, except the few
-- simple tables people manage themselves (collectors, notifications read state).
-- ---------------------------------------------------------------------------
grant select on public.settings, public.categories to anon, authenticated;
create policy "settings are public" on public.settings for select using (true);
create policy "categories are public" on public.categories for select using (true);

grant select, update (full_name, phone, language, last_seen_at) on public.profiles to authenticated;
create policy "own profile" on public.profiles for select using (id = auth.uid() or public.is_admin()
  or exists (select 1 from public.memberships a join public.memberships b on a.organisation_id = b.organisation_id
             where a.user_id = auth.uid() and b.user_id = profiles.id));
create policy "edit own profile" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

grant select on public.platform_admins to authenticated;
create policy "admins see admins" on public.platform_admins for select using (user_id = auth.uid() or public.is_admin());

grant select on public.organisations to authenticated;
create policy "own organisation or admin" on public.organisations for select using (public.is_member(id) or public.is_admin());

grant select on public.memberships to authenticated;
create policy "own memberships" on public.memberships for select using (user_id = auth.uid() or public.is_member(organisation_id) or public.is_admin());

grant select, insert, update, delete on public.collectors to authenticated;
create policy "collectors: read" on public.collectors for select using (public.is_member(organisation_id) or public.is_admin());
create policy "collectors: add" on public.collectors for insert with check (
  public.is_member(organisation_id)
  and exists (select 1 from public.organisations o where o.id = organisation_id and o.type = 'ngo')
  and (select count(*) from public.collectors c where c.organisation_id = collectors.organisation_id and c.active) < 5);
create policy "collectors: edit" on public.collectors for update using (public.is_member(organisation_id)) with check (public.is_member(organisation_id));
create policy "collectors: remove" on public.collectors for delete using (public.is_member(organisation_id)
  and not exists (select 1 from public.orders o where o.collector_id = collectors.id));

grant select on public.documents to authenticated;
create policy "documents: own or admin" on public.documents for select using (public.is_member(organisation_id) or public.is_admin());

grant select on public.listings to authenticated;
create policy "listings: own or admin" on public.listings for select using (public.is_member(vendor_id) or public.is_admin()
  or exists (select 1 from public.orders o where o.listing_id = listings.id and public.is_member(o.ngo_id)));

grant select on public.listing_photos to anon, authenticated;
create policy "photos are public" on public.listing_photos for select using (true);

-- Orders: both sides read their own orders, but never the pickup code column (it comes from order_details).
grant select (id, listing_id, vendor_id, ngo_id, claimed_by, collector_id, status, payment_mode, price_rs, commission_rs,
  vendor_share_rs, payment_deadline, held_until, ngo_payment_reference, ngo_marked_paid_at, paid_at, quantity_handed_over,
  picked_up_at, completed_at, collection_asked_at, ended_at, ended_reason, created_at) on public.orders to authenticated;
create policy "orders: either side or admin" on public.orders for select using (public.is_member(ngo_id) or public.is_member(vendor_id) or public.is_admin());

grant select on public.payments, public.refunds to authenticated;
create policy "payments: either side or admin" on public.payments for select using (public.is_admin()
  or exists (select 1 from public.orders o where o.id = order_id and (public.is_member(o.ngo_id) or public.is_member(o.vendor_id))));
create policy "refunds: either side or admin" on public.refunds for select using (public.is_admin()
  or exists (select 1 from public.orders o where o.id = order_id and (public.is_member(o.ngo_id) or public.is_member(o.vendor_id))));

grant select on public.payouts, public.payout_lines to authenticated;
create policy "payouts: admin" on public.payouts for select using (public.is_admin()
  or exists (select 1 from public.payout_lines pl where pl.payout_id = payouts.id and public.is_member(pl.vendor_id)));
create policy "payout lines: vendor or admin" on public.payout_lines for select using (public.is_member(vendor_id) or public.is_admin());

grant select on public.ledger_entries, public.payment_events, public.audit_log to authenticated;
create policy "ledger: admin" on public.ledger_entries for select using (public.is_admin());
create policy "payment events: admin" on public.payment_events for select using (public.is_admin());
create policy "audit: admin" on public.audit_log for select using (public.is_admin());

grant select on public.disputes to authenticated;
create policy "disputes: either side or admin" on public.disputes for select using (public.is_admin()
  or exists (select 1 from public.orders o where o.id = order_id and (public.is_member(o.ngo_id) or public.is_member(o.vendor_id))));

grant select on public.strikes, public.reliability_events to authenticated;
create policy "strikes: own or admin" on public.strikes for select using (public.is_member(organisation_id) or public.is_admin());
create policy "reliability: own or admin" on public.reliability_events for select using (public.is_member(organisation_id) or public.is_admin());

grant select, update (read_at) on public.notifications to authenticated;
create policy "notifications: own" on public.notifications for select using (user_id = auth.uid());
create policy "notifications: mark read" on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on public.policy_acceptances to authenticated;
create policy "acceptances: own or admin" on public.policy_acceptances for select using (user_id = auth.uid() or public.is_admin());

-- The service role (Edge Functions, scheduler) needs full access.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Live updates for the screens that change while people watch them.
alter publication supabase_realtime add table public.orders, public.notifications;

-- ---------------------------------------------------------------------------
-- File storage
--   listing-photos: public, so photos load fast; uploads only into your own business folder.
--   documents: private; your organisation's folder only; admins read through short-lived links.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-photos', 'listing-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
       ('documents', 'documents', false, 10485760, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do nothing;

create policy "photos: vendors upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'listing-photos' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "photos: vendors delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'listing-photos' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "photos: anyone can view" on storage.objects for select
  using (bucket_id = 'listing-photos');

create policy "documents: upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "documents: own or admin can read" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (public.is_member(((storage.foldername(name))[1])::uuid) or public.is_admin()));
