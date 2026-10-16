-- Rizq Rasan platform: a shorter list of documents, and three fixes.
--
-- 1. Many small food businesses have no NTN, no SECP registration and no
--    Food Authority licence yet. A business now needs only the owner's CNIC
--    and one proof that the business is real (any of: licence, NTN, business
--    registration, or a utility bill). An NGO needs its registration
--    certificate and the CNIC of the person in charge. The NTN is optional.
--    The server now checks these, not only the app.
-- 2. A Raast ID or IBAN left blank was saved as '' instead of null, so a
--    business that gave only an IBAN could never be claimed in direct mode.
--    Blank payment and tax fields are now stored as null.
-- 3. A business paused for strikes could not enter pickup codes, so NGOs that
--    had already paid could not collect. Handing over paid orders now works
--    while paused; new listings stay blocked.

-- 2. Blank text fields are stored as null.
create or replace function public.blank_to_null_org_fields() returns trigger
language plpgsql as $$
begin
  new.raast_id := nullif(btrim(new.raast_id), '');
  new.bank_iban := nullif(btrim(new.bank_iban), '');
  new.bank_account_title := nullif(btrim(new.bank_account_title), '');
  new.ntn := nullif(btrim(new.ntn), '');
  return new;
end $$;

drop trigger if exists organisations_blank_to_null on public.organisations;
create trigger organisations_blank_to_null before insert or update on public.organisations
  for each row execute function public.blank_to_null_org_fields();

update public.organisations set raast_id = raast_id
where raast_id = '' or bank_iban = '' or bank_account_title = '' or ntn = '';

-- 1. What an application needs before it can be submitted.
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
    if o.raast_id is null and o.bank_iban is null then raise exception 'Add a Raast ID or an IBAN so NGOs can pay you.'; end if;
  else
    if not exists (select 1 from public.documents where organisation_id = p_org and status <> 'rejected' and kind = 'registration') then
      raise exception 'Upload your registration certificate before submitting.';
    end if;
  end if;
  update public.organisations set status = 'pending_review', status_reason = null where id = p_org;
  perform public.notify_admins('verification', 'New application: ' || o.name, 'An application is waiting for review.', '/admin/verifications');
  perform public.notify_org(p_org, 'submitted', 'Application received', 'We check applications within 2 working days and will tell you if anything needs changing.');
end $$;

-- 3. Handover works while paused for strikes (approved businesses only).
create or replace function public.verify_pickup_code(p_vendor uuid, p_code text, p_quantity numeric default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders; l public.listings; lim jsonb; recent integer; v public.organisations;
begin
  perform public.require_member(p_vendor);
  select * into v from public.organisations where id = p_vendor;
  if v.type <> 'vendor' then raise exception 'This is only for business accounts.'; end if;
  if v.status <> 'approved' then raise exception 'Your account is not approved yet.'; end if;
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
