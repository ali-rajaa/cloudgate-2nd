-- Rizq Rasan platform: tables.
-- Money is stored in whole rupees (every price, commission and payout in the
-- rules is a whole rupee). Times are timestamptz (UTC), shown in Pakistan time.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.org_type as enum ('vendor', 'ngo');
create type public.org_status as enum ('onboarding', 'pending_review', 'needs_changes', 'approved', 'rejected', 'suspended', 'removed');
create type public.ngo_tier as enum ('A', 'B', 'C');
create type public.member_role as enum ('owner', 'staff');
create type public.admin_role as enum ('admin', 'payout_approver', 'super_admin', 'support');
create type public.doc_status as enum ('uploaded', 'approved', 'rejected', 'expired');
create type public.listing_status as enum ('draft', 'live', 'claimed', 'completed', 'expired', 'withdrawn', 'removed');
create type public.order_status as enum (
  'payment_due',          -- claimed, waiting for the NGO to pay
  'payment_processing',   -- gateway is confirming, or (direct mode) waiting for the vendor to confirm
  'paid',                 -- ready to collect
  'awaiting_collection_answer', -- pickup window + grace passed; vendor is asked "did they collect?"
  'picked_up',            -- code entered at the counter
  'completed',
  'completed_unconfirmed',
  'expired_unpaid', 'released', 'cancelled_by_ngo', 'cancelled_by_vendor', 'refused_at_pickup', 'no_show'
);
create type public.payment_mode as enum ('direct', 'payfast');
create type public.payment_status as enum ('pending', 'succeeded', 'failed', 'refunded', 'partly_refunded');
create type public.refund_status as enum ('pending_approval', 'approved', 'sent', 'rejected');
create type public.payout_status as enum ('draft', 'approved', 'sent');
create type public.payout_line_status as enum ('pending', 'eligible', 'in_batch', 'paid', 'on_hold');
create type public.dispute_status as enum ('open', 'awaiting_reply', 'decided', 'withdrawn');

-- ---------------------------------------------------------------------------
-- Settings: every value marked "setting" in Rules at a glance
-- ---------------------------------------------------------------------------
create table public.settings (
  key text primary key,
  value jsonb not null,
  description text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into public.settings (key, value, description) values
  ('payment_mode',               '"direct"', 'How NGOs pay: "direct" (NGO pays the vendor, vendor confirms) or "payfast" (through the gateway)'),
  ('commission_percent',         '5',        'Commission on each sale, services tax included, rounded down to the rupee'),
  ('charge_commission_in_direct_mode', 'false', 'Whether commission is owed on direct-mode (pilot) sales'),
  ('min_price_rs',               '1000',     'Lowest listing price'),
  ('max_price_share_of_retail',  '0.5',      'Highest price as a share of retail value'),
  ('payment_window_minutes',     '30',       'Payment deadline after a claim'),
  ('payment_cutoff_before_end_minutes', '15', 'Payment deadline is never later than this many minutes before pickup ends'),
  ('min_minutes_to_pay',         '10',       'Claiming is blocked if less time than this would be left to pay'),
  ('processing_grace_minutes',   '15',       'Extra hold while a payment is still processing at the deadline'),
  ('direct_confirm_minutes',     '15',       'Direct mode: time for the vendor to confirm payment before an admin is alerted'),
  ('min_listing_lead_minutes',   '60',       'Pickup must end at least this long after publishing'),
  ('min_pickup_window_minutes',  '30',       'Shortest pickup window'),
  ('safe_until_margin_minutes',  '30',       'Pickup must end at least this long before safe-until'),
  ('cancel_refund_minutes',      '60',       'NGO cancelling at least this long before pickup starts gets a full refund'),
  ('no_show_grace_minutes',      '30',       'After the pickup window ends, wait this long before asking the vendor'),
  ('problem_report_hours',       '24',       'Time after pickup to report a problem; then the order completes'),
  ('unconfirmed_complete_hours', '48',       'Orders nobody confirms complete after this long'),
  ('strike_expiry_days',         '60',       'Strikes expire after this many days'),
  ('unpaid_expiry_pause',        '{"count": 3, "days": 7, "pause_hours": 24}', 'Unpaid expiries that trigger a pause on claiming'),
  ('tier_limits',                '{"C": {"unpaid": 1, "daily": 2}, "B": {"unpaid": 2, "daily": 6}, "A": {"unpaid": 3, "daily": null}}', 'NGO claim limits by trust tier'),
  ('reliability_floor',          '60',       'Below this score, NGOs drop to Tier C limits and vendors are limited to 3 live listings'),
  ('payout_account_pause_hours', '48',       'Payouts pause for this long after a payout account change'),
  ('second_admin_refund_rs',     '10000',    'Refunds above this need a second admin'),
  ('cooked_food_open',           'false',    'Whether cooked food categories can be listed (opens 1 February 2027 if no incident)'),
  ('hot_months',                 '[5, 6, 7, 8, 9]', 'Months (1-12) when cooked food at room temperature is not allowed'),
  ('browse_radius_km',           '5',        'Default browse radius for NGOs'),
  ('pickup_code_attempts',       '{"max": 5, "window_minutes": 10, "lock_minutes": 10}', 'Wrong pickup-code attempts before entry locks');

-- ---------------------------------------------------------------------------
-- Food categories and their time limits (hours from preparation / opening)
-- ---------------------------------------------------------------------------
create table public.categories (
  id text primary key,
  name text not null,
  cooked boolean not null default false,
  max_hours_room integer,          -- null = not allowed at room temperature
  max_hours_hot integer,           -- hot-held at 60°C or more; null = not allowed
  max_hours_chilled integer,       -- chilled at 5°C or less; null = not allowed
  uses_label_date boolean not null default false,  -- safe-until is the label date
  opens text not null check (opens in ('pilot', 'cooked', 'phase2')),
  sort integer not null default 0
);

-- Matches the table on the public Food safety page (/food-safety/).
insert into public.categories (id, name, cooked, max_hours_room, max_hours_hot, max_hours_chilled, uses_label_date, opens, sort) values
  ('tandoor_breads', 'Tandoor breads (naan, roti, paratha, sheermal)',          false, 18,   null, 18,   false, 'pilot',  1),
  ('plain_bakery',   'Plain bakery (bread, buns, rusk, plain cake)',            false, 24,   null, 24,   false, 'pilot',  2),
  ('cream_bakery',   'Bakery with cream, custard or filling',                   false, null, null, 6,    false, 'phase2', 3),
  ('cooked_rice',    'Cooked rice (biryani, pulao)',                            true,  2,    4,    24,   false, 'cooked', 4),
  ('curries',        'Curries, daal, haleem, nihari, salan',                    true,  2,    4,    24,   false, 'cooked', 5),
  ('fried_snacks',   'Fried snacks and iftar items (samosa, pakora, rolls)',    true,  2,    4,    24,   false, 'cooked', 6),
  ('mithai',         'Mithai and desserts without cream',                       false, 48,   null, 48,   false, 'pilot',  7),
  ('fruit_veg',      'Fruit and vegetables',                                    false, 72,   null, 72,   false, 'pilot',  8),
  ('dairy',          'Dairy (milk, dahi, paneer, lassi)',                       false, null, null, null, true,  'phase2', 9),
  ('packaged',       'Packaged and dry goods (atta, rice, daal, oil, biscuits)', false, null, null, null, true,  'pilot',  10),
  ('drinks',         'Drinks and juices',                                       false, null, null, null, true,  'pilot',  11);

-- ---------------------------------------------------------------------------
-- People and organisations
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  phone text,                       -- stored as +923001234567
  language text not null default 'en' check (language in ('en', 'ur')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.admin_role not null default 'admin',
  created_at timestamptz not null default now()
);

create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  type public.org_type not null,
  name text not null check (length(trim(name)) between 2 and 120),
  legal_name text,
  status public.org_status not null default 'onboarding',
  status_reason text,
  tier public.ngo_tier,                        -- NGOs only
  tier_c_until timestamptz,                    -- NGOs stay in Tier C at least until this time
  business_kind text,                          -- bakery, restaurant, grocer, cafe / NGO, shelter, kitchen...
  registration_kind text,                      -- SECP, partnership, sole proprietor / Societies Act, Trust Act...
  registration_number text,
  ntn text,
  phone text,
  email text,
  address text,
  sector text,                                 -- e.g. F-7 Markaz, G-9/4
  lat double precision check (lat between 33.4 and 33.9),
  lng double precision check (lng between 72.7 and 73.4),
  pickup_instructions text,
  people_served_per_day integer check (people_served_per_day > 0),
  -- direct payment mode: where NGOs send money for this vendor
  raast_id text,
  bank_account_title text,
  bank_iban text,
  payouts_paused_until timestamptz,
  claims_paused_until timestamptz,             -- NGOs: 24-hour pause after 3 unpaid expiries
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  constraint tier_only_for_ngos check (type = 'ngo' or tier is null)
);

create table public.memberships (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (organisation_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

create table public.collectors (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 80),
  phone text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  kind text not null,
  file_path text not null,                     -- path in the private "documents" bucket: <org id>/<file>
  status public.doc_status not null default 'uploaded',
  reason text,
  expires_on date,
  uploaded_by uuid references auth.users (id),
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index documents_org_idx on public.documents (organisation_id);

-- ---------------------------------------------------------------------------
-- Listings and orders
-- ---------------------------------------------------------------------------
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.organisations (id) on delete cascade,
  title text not null check (length(trim(title)) between 3 and 80),
  description text,
  category_id text not null references public.categories (id),
  quantity numeric not null check (quantity > 0),
  unit text not null default 'pieces',
  weight_kg numeric not null check (weight_kg > 0 and weight_kg <= 500),
  feeds_about integer check (feeds_about > 0),
  retail_value_rs integer not null check (retail_value_rs > 0),
  price_rs integer not null check (price_rs > 0),
  storage text not null default 'room' check (storage in ('room', 'hot', 'chilled')),
  prepared_at timestamptz not null,
  safe_until timestamptz not null,
  pickup_start timestamptz not null,
  pickup_end timestamptz not null,
  dietary jsonb not null default '{}'::jsonb,  -- {"vegetarian": true, "contains": ["gluten","milk"], "meat": ["chicken"], "halal": "vendor_declared"}
  instructions text,
  status public.listing_status not null default 'live',
  status_reason text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pickup_window_order check (pickup_end > pickup_start)
);
create index listings_live_idx on public.listings (status, pickup_end) where status = 'live';
create index listings_vendor_idx on public.listings (vendor_id, status);

create table public.listing_photos (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  file_path text not null,                     -- path in the public "listing-photos" bucket
  sort integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id),
  vendor_id uuid not null references public.organisations (id),
  ngo_id uuid not null references public.organisations (id),
  claimed_by uuid references auth.users (id),
  collector_id uuid references public.collectors (id),
  status public.order_status not null default 'payment_due',
  payment_mode public.payment_mode not null,
  price_rs integer not null,
  commission_rs integer not null,
  vendor_share_rs integer not null,
  payment_deadline timestamptz not null,
  held_until timestamptz,
  pickup_code text not null,                   -- 4 digits; NGOs read it, vendors can only check it
  code_attempts integer not null default 0,
  code_window_started_at timestamptz,
  code_locked_until timestamptz,
  ngo_payment_reference text,                  -- direct mode: the NGO's Raast/bank reference
  ngo_marked_paid_at timestamptz,
  paid_at timestamptz,
  quantity_handed_over numeric,
  picked_up_at timestamptz,
  completed_at timestamptz,
  collection_asked_at timestamptz,
  ended_at timestamptz,
  ended_reason text,
  created_at timestamptz not null default now(),
  constraint split_adds_up check (commission_rs + vendor_share_rs = price_rs)
);
-- Only one active claim per listing, so a bug can never double-book food.
create unique index orders_one_active_per_listing on public.orders (listing_id)
  where status in ('payment_due', 'payment_processing', 'paid', 'awaiting_collection_answer', 'picked_up');
create index orders_ngo_idx on public.orders (ngo_id, status);
create index orders_vendor_idx on public.orders (vendor_id, status);
create index orders_deadline_idx on public.orders (payment_deadline) where status in ('payment_due', 'payment_processing');

-- ---------------------------------------------------------------------------
-- Money
-- ---------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id),
  gateway text not null,                       -- 'payfast' or 'direct'
  gateway_reference text,
  method text,                                 -- raast, jazzcash, easypaisa, card, bank
  amount_rs integer not null check (amount_rs > 0),
  status public.payment_status not null default 'pending',
  created_at timestamptz not null default now(),
  succeeded_at timestamptz
);
create unique index payments_gateway_ref_unique on public.payments (gateway, gateway_reference) where gateway_reference is not null;
create unique index payments_one_success_per_order on public.payments (order_id) where status in ('succeeded', 'refunded', 'partly_refunded');

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  gateway text not null,
  event_id text not null,
  signature_valid boolean not null,
  body jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  result text,
  unique (gateway, event_id)
);

create table public.ledger_entries (
  id bigint generated always as identity primary key,
  txn_id uuid not null,
  account text not null,                       -- gateway_clearing, vendor_payable, commission_revenue, refunds_payable, ...
  organisation_id uuid references public.organisations (id),
  order_id uuid references public.orders (id),
  debit_rs integer not null default 0 check (debit_rs >= 0),
  credit_rs integer not null default 0 check (credit_rs >= 0),
  memo text,
  created_at timestamptz not null default now(),
  check ((debit_rs = 0) <> (credit_rs = 0))
);
create index ledger_txn_idx on public.ledger_entries (txn_id);
create index ledger_org_idx on public.ledger_entries (organisation_id, account);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id),
  payment_id uuid references public.payments (id),
  amount_rs integer not null check (amount_rs > 0),
  reason text not null,
  borne_by text not null check (borne_by in ('vendor', 'ngo', 'platform')),
  status public.refund_status not null default 'approved',
  requested_by uuid references auth.users (id),
  approved_by uuid references auth.users (id),
  gateway_reference text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  run_date date not null unique,
  status public.payout_status not null default 'draft',
  total_rs integer not null default 0,
  prepared_by uuid references auth.users (id),
  approved_by uuid references auth.users (id),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint two_people check (approved_by is null or prepared_by is null or approved_by <> prepared_by)
);

create table public.payout_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders (id),
  vendor_id uuid not null references public.organisations (id),
  payout_id uuid references public.payouts (id),
  gross_rs integer not null,
  commission_rs integer not null,
  tax_withheld_rs integer not null default 0,
  deductions_rs integer not null default 0,
  net_rs integer not null,
  status public.payout_line_status not null default 'pending',
  hold_reason text,
  bank_reference text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index payout_lines_vendor_idx on public.payout_lines (vendor_id, status);

-- ---------------------------------------------------------------------------
-- Trust and safety
-- ---------------------------------------------------------------------------
create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id),
  raised_by_org uuid not null references public.organisations (id),
  raised_by uuid references auth.users (id),
  kind text not null check (kind in ('food_safety', 'short_handover', 'vendor_closed', 'not_ready', 'wrong_food', 'payment', 'conduct', 'other')),
  details text not null,
  reply text,
  status public.dispute_status not null default 'open',
  decision text,
  refund_rs integer,
  strike_org uuid references public.organisations (id),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.strikes (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  order_id uuid references public.orders (id),
  reason text not null,
  expires_at timestamptz not null,
  forgiven_by uuid references auth.users (id),
  forgiven_at timestamptz,
  created_at timestamptz not null default now()
);
create index strikes_org_idx on public.strikes (organisation_id, expires_at);

create table public.reliability_events (
  id bigint generated always as identity primary key,
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  order_id uuid references public.orders (id),
  score numeric not null check (score between 0 and 1),
  note text,
  created_at timestamptz not null default now()
);
create index reliability_org_idx on public.reliability_events (organisation_id, created_at);

-- ---------------------------------------------------------------------------
-- Messages and records
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  organisation_id uuid references public.organisations (id) on delete cascade,
  event text not null,
  title text not null,
  body text not null,
  link text,
  read_at timestamptz,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unsent_idx on public.notifications (created_at) where emailed_at is null;

create table public.policy_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  organisation_id uuid references public.organisations (id) on delete cascade,
  policy text not null,
  version text not null,
  accepted_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid,
  action text not null,
  table_name text,
  row_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
